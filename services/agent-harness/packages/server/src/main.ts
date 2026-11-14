/**
 * Protocol server entrypoint — `node packages/server/dist/main.js`.
 *
 * Boots one RuntimeHost (same wiring as the CLI) and serves the native web client on
 * http://127.0.0.1:4173. A dead model backend degrades the process instead of killing it:
 * `/api/health` explains what to start and the UI keeps polling.
 *
 * 平台集成（agent-platform sidecar 形态）：HOST 环境变量覆盖绑定地址——默认保持
 * 本地信任（127.0.0.1，绝不裸奔公网）；容器内经 HOST=0.0.0.0 仅供反代网关访问。
 */
import { RuntimeHost } from "./runtime-host.js";
import { startProtocolServer } from "./http.js";

const host = new RuntimeHost({ cwd: process.cwd() });
await host.start();

const bindHost = process.env.HOST ?? "127.0.0.1";
const running = await startProtocolServer(host, {
  host: bindHost,
  port: Number(process.env.PORT ?? 4173),
});

console.log(`Agent Harness protocol server → http://${bindHost}:${running.port}`);
const health = host.healthSnapshot();
if (health.status === "degraded") {
  console.error(`⚠ 降级运行：${health.hint ?? "模型后端不可用"}`);
} else {
  console.error(`  model ${health.model} (${health.provider}) · ctx ${health.contextWindow}`);
}

const shutdown = (signal: string): void => {
  console.error(`\n${signal} → 关闭 protocol server`);
  void running.close().then(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
