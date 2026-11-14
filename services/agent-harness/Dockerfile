# agent-harness sidecar（agent-platform 集成形态，ADR-019）：
# TS monorepo 构建 + 协议服务器。构建上下文 = services/agent-harness/（compose: build: ./services/agent-harness）
FROM node:22-slim AS build
WORKDIR /build
# .dockerignore 已排除本地构建产物（node_modules/dist/traces/.harness）
COPY . .
# 不用 corepack：其签名校验对 lockfileVersion 9（pnpm 9/10）存在 keyid 漂移问题，npm 直装更稳
RUN npm install -g pnpm@10 --silent \
    && pnpm install --frozen-lockfile \
    # 防御：宿主机构建的 tsbuildinfo 记录的是宿主路径的 up-to-date 状态，
    # 会让 tsc -b 跳过重建导致 dist 缺失（composite 增量构建已知坑）
    && find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete \
    && pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /build ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    # 运行时状态根（config.yaml / sessions / knowledge / qdrant），compose 挂命名卷持久化
    && mkdir -p /root/.harness
# 绑定地址默认本地信任（127.0.0.1，见 packages/server/src/main.ts）；容器内由 compose 以 HOST=0.0.0.0 覆盖，
# 仅暴露在 compose 内网供平台网关反代访问，绝不映射宿主机端口
EXPOSE 4173
ENTRYPOINT ["docker-entrypoint.sh"]
