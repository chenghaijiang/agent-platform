# fake-openai：OpenAI-compatible 演示服务（T03）：仅标准库，免真实 API key 即可演示网关与观测链路
FROM docker.io/library/python:3.12-slim

COPY server.py /app/server.py
EXPOSE 8000
CMD ["python", "/app/server.py"]
