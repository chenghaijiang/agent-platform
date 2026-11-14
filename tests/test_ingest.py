"""入库流水线单测（T05）：解析 / 切分 / 上传幂等 / 状态机与租约 / 全流程落 chunks。

SQLite 内存库验证状态机语义（SQLite 方言忽略 FOR UPDATE，SKIP LOCKED 本身
由容器端到端在 PG 上验证）；对象存储与模型网关用内存假实现。
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import agent_platform.ingest.api as ingest_api
from agent_platform.api.deps import get_session
from agent_platform.auth.deps import require_admin
from agent_platform.auth.provider import AuthContext
from agent_platform.db.models import Base, IngestTask, KbChunk, KnowledgeBase, Role
from agent_platform.ingest import service
from agent_platform.ingest.chunker import chunk_sections
from agent_platform.ingest.parser import (
    ParsedSection,
    UnsupportedDocumentError,
    parse,
    parse_markdown,
)
from agent_platform.ingest.worker import process_task
from agent_platform.model_gateway.gateway import EmbedResult

ADMIN = AuthContext(user_id="u1", username="tester", role="admin", provider="test")


def _aware(dt: datetime) -> datetime:
    """SQLite 读回 naive datetime（存储格式无 tzinfo），统一补 UTC 再比较。"""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


class FakeStorage:
    """内存对象存储：记录 put/get，供全流程测试与幂等断言。"""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.put_calls: list[str] = []

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        self.objects[key] = data
        self.put_calls.append(key)

    def get(self, key: str) -> bytes:
        return self.objects[key]


class FakeGateway:
    """假模型网关：embed 返回确定性向量（文本长度模 10），并记录调用批次。"""

    def __init__(self) -> None:
        self.batches: list[list[str]] = []

    async def embed(self, texts: list[str], *, model: str | None = None) -> EmbedResult:
        self.batches.append(list(texts))
        return EmbedResult(
            vectors=[[float(len(t) % 10), 1.0, 2.0] for t in texts],
            model="fake-embedding-1",
            usage={"input": sum(len(t) for t in texts), "total": sum(len(t) for t in texts)},
            latency_ms=1,
        )


@pytest_asyncio.fixture()
async def env():
    engine = create_async_engine("sqlite+aiosqlite://")

    @event.listens_for(engine.sync_engine, "connect")
    def _fk_on(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        session.add(Role(name="admin"))
        kb = KnowledgeBase(name="员工手册", classification="confidential")
        session.add(kb)
        await session.commit()
        kb_id = kb.id

    storage = FakeStorage()
    gateway = FakeGateway()

    app = FastAPI()
    app.include_router(ingest_api.router)

    async def fake_session():
        async with factory() as s:
            yield s

    app.dependency_overrides[get_session] = fake_session
    app.dependency_overrides[require_admin] = lambda: ADMIN
    app.dependency_overrides[ingest_api.get_storage] = lambda: storage

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac, factory, storage, gateway, kb_id
    await engine.dispose()


async def _seed_task(factory, kb_id, *, filename="doc.md", data=b"content", attempt=0, status="queued"):
    async with factory() as session:
        task = IngestTask(
            kb_id=kb_id,
            status=status,
            attempt=attempt,
            source_filename=filename,
            content_hash=service.content_hash_of(data),
            object_key=f"kb/{kb_id}/seed/{filename}",
        )
        session.add(task)
        await session.commit()
        return task.id


# ---------------- parser ----------------


def test_parse_markdown_builds_heading_stack():
    md = "# 平台概述\n正文一\n## 安装\n步骤\n### 前置条件\n依赖\n## 部署\n上线"
    sections = parse_markdown(md)
    assert [(s.heading_path, s.text) for s in sections] == [
        ("平台概述", "正文一"),
        ("平台概述/安装", "步骤"),
        ("平台概述/安装/前置条件", "依赖"),
        ("平台概述/部署", "上线"),
    ]


def test_parse_markdown_ignores_empty_heading_and_blank_lines():
    # 无文本的 # 行（"#### "）不是标题也不是正文；空行不入块
    sections = parse_markdown("# 标题\n\n\n#### \n普通行")
    assert [(s.heading_path, s.text) for s in sections] == [("标题", "普通行")]


def test_parse_pdf_pages(monkeypatch):
    class FakePage:
        def __init__(self, text):
            self._text = text

        def extract_text(self):
            return self._text

    class FakeReader:
        def __init__(self, _stream):
            self.pages = [FakePage("第一页内容"), FakePage("   "), FakePage("第二页内容")]

    monkeypatch.setattr("pypdf.PdfReader", FakeReader)
    sections = parse("spec.pdf", b"%PDF-fake")
    assert [s.heading_path for s in sections] == ["第 1 页", "第 3 页"]
    assert sections[0].text == "第一页内容"


def test_parse_rejects_unsupported_format():
    with pytest.raises(UnsupportedDocumentError):
        parse("notes.txt", b"hello")


# ---------------- chunker ----------------


def test_chunker_keeps_blocks_within_limit_and_merges():
    section = ParsedSection("指南", "A" * 600 + "\n\n" + "B" * 300)
    chunks = chunk_sections([section], max_chars=1000)
    assert len(chunks) == 1
    assert len(chunks[0].content) == 902  # 600 + 2(\\n\\n) + 300
    assert chunks[0].heading_path == "指南"


def test_chunker_hard_splits_oversized_paragraph():
    chunks = chunk_sections([ParsedSection("长文", "X" * 2500)], max_chars=1000)
    assert [len(c.content) for c in chunks] == [1000, 1000, 500]


def test_chunker_does_not_merge_across_heading_sections():
    sections = [ParsedSection("第一章", "甲" * 600), ParsedSection("第二章", "乙" * 600)]
    chunks = chunk_sections(sections, max_chars=1000)
    assert [c.heading_path for c in chunks] == ["第一章", "第二章"]


# ---------------- 上传 API（幂等） ----------------


async def test_upload_returns_queued_task_immediately(env):
    ac, _factory, storage, _gateway, kb_id = env
    resp = await ac.post(
        f"/api/admin/kbs/{kb_id}/documents",
        files={"file": ("handbook.md", "# 手册\n入职流程说明".encode(), "text/markdown")},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["status"] == "queued"
    assert body["attempt"] == 0
    assert body["duplicate"] is False
    # 原始文件已归档对象存储，且 HTTP 请求不等待解析（task 已立即返回）
    assert any(key.endswith("handbook.md") for key in storage.objects)


async def test_upload_same_content_is_idempotent(env):
    ac, _factory, _storage, _gateway, kb_id = env
    payload = ("report.md", "# 报告\n同一份内容".encode(), "text/markdown")
    first = await ac.post(f"/api/admin/kbs/{kb_id}/documents", files={"file": payload})
    second = await ac.post(f"/api/admin/kbs/{kb_id}/documents", files={"file": payload})
    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["duplicate"] is True
    assert second.json()["id"] == first.json()["id"]
    # 对象存储只写一次
    assert len({k for k in _storage.put_calls if "report.md" in k}) == 1


async def test_upload_reuses_succeeded_task_to_avoid_duplicate_chunks(env):
    """已入库（succeeded）的文档重复上传必须复用任务，否则 chunks 会翻倍。"""
    ac, factory, storage, gateway, kb_id = env
    data = "# 手册\n已成功入库的内容".encode()
    payload = ("done.md", data, "text/markdown")
    first = await ac.post(f"/api/admin/kbs/{kb_id}/documents", files={"file": payload})
    task_uuid = uuid.UUID(first.json()["id"])

    async with factory() as session:
        task = await session.get(IngestTask, task_uuid)
        count = await process_task(session, task, storage=storage, gateway=gateway)
        await service.mark_succeeded(session, task_uuid)
        assert count > 0

    again = await ac.post(f"/api/admin/kbs/{kb_id}/documents", files={"file": payload})
    assert again.status_code == 200
    assert again.json()["duplicate"] is True
    assert again.json()["id"] == str(task_uuid)
    assert again.json()["status"] == "succeeded"


async def test_upload_unsupported_type_415(env):
    ac, _f, _s, _g, kb_id = env
    resp = await ac.post(
        f"/api/admin/kbs/{kb_id}/documents",
        files={"file": ("notes.txt", b"plain", "text/plain")},
    )
    assert resp.status_code == 415
    assert resp.json()["detail"]["supported"] == [".md", ".markdown", ".pdf"]


async def test_upload_unknown_kb_404(env):
    ac, _f, _s, _g, _kb = env
    resp = await ac.post(
        "/api/admin/kbs/00000000-0000-0000-0000-000000000000/documents",
        files={"file": ("a.md", b"x", "text/markdown")},
    )
    assert resp.status_code == 404


async def test_upload_empty_file_422(env):
    ac, _f, _s, _g, kb_id = env
    resp = await ac.post(
        f"/api/admin/kbs/{kb_id}/documents",
        files={"file": ("empty.md", b"", "text/markdown")},
    )
    assert resp.status_code == 422


# ---------------- 认领与状态机（ADR-005） ----------------


async def test_claim_moves_queued_to_running_with_lease(env):
    _ac, factory, _s, _g, kb_id = env
    task_id = await _seed_task(factory, kb_id)
    async with factory() as session:
        claimed = await service.claim_next_task(session, lease_seconds=60)
        assert claimed is not None
        assert claimed.id == task_id
        assert claimed.status == "running"
        assert claimed.attempt == 1
        assert claimed.lease_expires_at is not None
        assert _aware(claimed.lease_expires_at) > datetime.now(UTC)


async def test_claim_returns_none_when_no_task(env):
    _ac, factory, _s, _g, _kb = env
    async with factory() as session:
        assert await service.claim_next_task(session, lease_seconds=60) is None


async def test_claim_reclaims_expired_lease(env):
    """租约生效：running 且租约过期的任务可被重新认领，attempt 累加。"""
    _ac, factory, _s, _g, kb_id = env
    task_id = await _seed_task(factory, kb_id, attempt=1, status="running")
    async with factory() as session:
        await session.execute(
            IngestTask.__table__.update()
            .where(IngestTask.id == task_id)
            .values(lease_expires_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()
    async with factory() as session:
        reclaimed = await service.claim_next_task(session, lease_seconds=60)
        assert reclaimed is not None and reclaimed.id == task_id
        assert reclaimed.attempt == 2


async def test_claim_respects_retry_backoff(env):
    """failed 且退避未到期不可认领；到期后可重新认领。"""
    _ac, factory, _s, _g, kb_id = env
    task_id = await _seed_task(factory, kb_id, attempt=1, status="failed")
    async with factory() as session:
        await session.execute(
            IngestTask.__table__.update()
            .where(IngestTask.id == task_id)
            .values(next_retry_at=datetime.now(UTC) + timedelta(seconds=3600))
        )
        await session.commit()
    async with factory() as session:
        assert await service.claim_next_task(session, lease_seconds=60) is None
        await session.execute(
            IngestTask.__table__.update()
            .where(IngestTask.id == task_id)
            .values(next_retry_at=datetime.now(UTC) - timedelta(seconds=1))
        )
        await session.commit()
    async with factory() as session:
        claimed = await service.claim_next_task(session, lease_seconds=60)
        assert claimed is not None and claimed.attempt == 2


async def test_mark_failed_dead_after_max_attempts(env):
    _ac, factory, _s, _g, kb_id = env
    task_id = await _seed_task(factory, kb_id, attempt=3, status="running")
    async with factory() as session:
        final = await service.mark_failed(session, task_id, "boom", backoff_seconds=10)
        assert final == "dead"
        task = await session.get(IngestTask, task_id)
        assert task.status == "dead"
        assert task.last_error == "boom"
        assert task.next_retry_at is None


async def test_mark_failed_sets_backoff_before_exhaustion(env):
    _ac, factory, _s, _g, kb_id = env
    task_id = await _seed_task(factory, kb_id, attempt=1, status="running")
    async with factory() as session:
        final = await service.mark_failed(session, task_id, "transient", backoff_seconds=30)
        assert final == "failed"
        task = await session.get(IngestTask, task_id)
        assert task.next_retry_at is not None
        assert _aware(task.next_retry_at) > datetime.now(UTC)


# ---------------- 全流程（解析 → 切分 → 向量化 → 落 chunks） ----------------


async def test_process_task_writes_chunks_with_metadata(env):
    _ac, factory, storage, gateway, kb_id = env
    doc = (
        "# 入职指南\n第一天流程说明，内容较长需要切分。" + "补充细节。" * 40
        + "\n\n## IT 设备\n领取笔记本流程。"
    ).encode()
    task_id = await _seed_task(factory, kb_id, filename="onboard.md", data=doc)
    storage.objects[f"kb/{kb_id}/seed/onboard.md"] = doc

    async with factory() as session:
        task = await session.get(IngestTask, task_id)
        count = await process_task(session, task, storage=storage, gateway=gateway)
        await service.mark_succeeded(session, task_id)

        rows = (
            await session.scalars(
                select(KbChunk).where(KbChunk.task_id == task_id).order_by(KbChunk.chunk_index)
            )
        ).all()
        assert count == len(rows) >= 2
        assert task.status == "succeeded"
        # 标题层级作为元数据保留；密级冗余自 KB（供 T06 ACL 过滤）
        assert rows[0].heading_path == "入职指南"
        assert any(r.heading_path == "入职指南/IT 设备" for r in rows)
        assert all(r.classification == "confidential" for r in rows)
        # 向量来自网关（fake 网关 3 维），content_hash 为块级指纹
        assert all(len(r.embedding) == 3 for r in rows)
        assert gateway.batches  # 至少一批向量化调用


async def test_process_task_failure_feeds_retry_state_machine(env):
    """解析失败 → failed（退避）→ 重试耗尽 → dead，全链路状态可见。"""
    _ac, factory, _storage, _gateway, kb_id = env
    task_id = await _seed_task(factory, kb_id, filename="broken.md", data=b"x")

    async with factory() as session:
        claimed = await service.claim_next_task(session, lease_seconds=60)
        assert claimed.id == task_id

        # 模拟解析失败：对象存储缺文件
        class EmptyStorage:
            def get(self, _key):
                raise KeyError("missing object")

        try:
            await process_task(session, claimed, storage=EmptyStorage(), gateway=FakeGateway())
            raise AssertionError("should fail")
        except KeyError:
            pass
        assert (
            await service.mark_failed(session, task_id, "KeyError: missing object", backoff_seconds=0)
            == "failed"
        )

    # 第二次认领（退避 0 秒已到期）→ 再失败 → dead（max_attempts=3, attempt 已 2）
    async with factory() as session:
        claimed = await service.claim_next_task(session, lease_seconds=60)
        assert claimed is not None and claimed.attempt == 2
        await service.mark_failed(session, task_id, "KeyError: missing object", backoff_seconds=0)
        claimed = await service.claim_next_task(session, lease_seconds=60)
        assert claimed is not None and claimed.attempt == 3
        final = await service.mark_failed(session, task_id, "KeyError: missing object", backoff_seconds=0)
        assert final == "dead"
        task = await session.get(IngestTask, task_id)
        assert task.status == "dead"
        assert "KeyError" in task.last_error


async def test_task_status_endpoint_exposes_state_machine(env):
    ac, factory, _s, _g, kb_id = env
    task_id = await _seed_task(factory, kb_id, attempt=1, status="failed")
    resp = await ac.get(f"/api/admin/ingest/tasks/{task_id}")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "failed"
    assert body["attempt"] == 1
    assert body["max_attempts"] == 3

    listed = (await ac.get(f"/api/admin/kbs/{kb_id}/tasks")).json()
    assert [t["id"] for t in listed] == [str(task_id)]

    resp = await ac.get("/api/admin/ingest/tasks/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
