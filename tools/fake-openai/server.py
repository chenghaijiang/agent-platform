"""fake-openai：OpenAI-compatible 演示服务（T03 专用，仅本地/演示用途）。

提供 /v1/chat/completions 与 /v1/embeddings 两个标准端点，响应含 usage 字段，
使"模型网关 → Langfuse 上报"全链路无需真实 API key 即可端到端演示。
切换真实模型时仅需改 .env 的 MODEL_GATEWAY_BASE_URL / API_KEY / 模型名。

仅用标准库实现（http.server），保持演示服务零依赖。
"""

import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

_EMBEDDING_DIM = 1536


def _usage_for_text(text: str) -> dict:
    # 粗略伪 token 计数：每 4 字符约 1 token（演示语义，非真实 tokenizer）
    prompt_tokens = max(1, len(text) // 4)
    return {"prompt_tokens": prompt_tokens, "total_tokens": prompt_tokens}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # 静默访问日志
        pass

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._json(200, {"status": "ok", "service": "fake-openai"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return

        model = request.get("model", "unknown")

        if self.path == "/v1/chat/completions":
            messages = request.get("messages", [])
            # T10 验证辅助：打印 system 头部，供人工确认链路读取的是发布版 Prompt
            system_head = next((m.get("content", "")[:50] for m in messages if m.get("role") == "system"), "")
            print(f"[fake-openai] chat system head: {system_head!r}", flush=True)
            last_user = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), ""
            )
            content = f"[fake-openai echo] {last_user}"
            usage = _usage_for_text("".join(str(m.get("content", "")) for m in messages))
            completion_tokens = len(content) // 4 + 1
            usage["completion_tokens"] = completion_tokens
            usage["total_tokens"] = usage["prompt_tokens"] + completion_tokens
            completion_id = f"chatcmpl-fake-{int(time.time()*1000)}"
            created = int(time.time())
            if request.get("stream"):
                # T07：流式响应（SSE，chunk 分片），供 LangGraph 生成节点逐 token 推送验证
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                for start in range(0, len(content), 12):
                    chunk = {
                        "id": completion_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {"index": 0, "delta": {"content": content[start : start + 12]}, "finish_reason": None}
                        ],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                final = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": usage,
                }
                self.wfile.write(f"data: {json.dumps(final)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                return
            self._json(
                200,
                {
                    "id": completion_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": usage,
                },
            )
        elif self.path == "/v1/embeddings":
            inputs = request.get("input", [])
            if isinstance(inputs, str):
                inputs = [inputs]
            usage = _usage_for_text(" ".join(str(i) for i in inputs))
            self._json(
                200,
                {
                    "object": "list",
                    "model": model,
                    "data": [
                        {
                            "object": "embedding",
                            "index": idx,
                            # 确定性向量（首元素带索引信息，便于联调区分）
                            "embedding": [1.0 if j == 0 else 0.0 for j in range(_EMBEDDING_DIM)],
                        }
                        for idx, _ in enumerate(inputs)
                    ],
                    "usage": usage,
                },
            )
        else:
            self._json(404, {"error": "not found"})


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
