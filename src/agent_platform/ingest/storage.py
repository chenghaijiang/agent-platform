"""对象存储封装（T05）：原始文档归档到平台 MinIO 实例（独立于 Langfuse 的）。

boto3 是同步 SDK：async 调用方一律 asyncio.to_thread 包装（Worker 内已处理）。
"""

import boto3
from botocore.config import Config as BotoConfig

from agent_platform.core.config import settings


class DocumentStorage:
    def __init__(self, *, endpoint: str, access_key: str, secret_key: str, bucket: str) -> None:
        self._bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="us-east-1",  # MinIO 不校验 region，占位即可
            config=BotoConfig(s3={"addressing_style": "path"}, retries={"max_attempts": 2}),
        )

    @classmethod
    def from_settings(cls) -> "DocumentStorage":
        return cls(
            endpoint=settings.minio_endpoint,
            access_key=settings.minio_access_key,
            secret_key=settings.minio_secret_key,
            bucket=settings.minio_bucket,
        )

    def ensure_bucket(self) -> None:
        """幂等建桶：已存在则跳过（HeadBucket 404 → CreateBucket）。"""
        try:
            self._client.head_bucket(Bucket=self._bucket)
        except self._client.exceptions.NoSuchBucket:
            self._client.create_bucket(Bucket=self._bucket)
        except self._client.exceptions.ClientError:
            # 某些 MinIO 版本对不存在桶返回通用 404/400 ClientError 而非 NoSuchBucket
            self._client.create_bucket(Bucket=self._bucket)

    def put(self, object_key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        self._client.put_object(Bucket=self._bucket, Key=object_key, Body=data, ContentType=content_type)

    def get(self, object_key: str) -> bytes:
        response = self._client.get_object(Bucket=self._bucket, Key=object_key)
        return response["Body"].read()
