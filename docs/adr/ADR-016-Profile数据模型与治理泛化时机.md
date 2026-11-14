# ADR-016：Profile 数据模型、模型策略与治理泛化时机

- 状态：已接受
- 日期：2026-11-14
- 关联：ADR-010（Prompt 三层治理）、ADR-012（Agent 执行域）、ADR-014、ADR-015
- 来源：grill-with-docs 审问第三轮裁决（Q13–Q18 按推荐接受）

## 决策

1. **Profile 数据模型（Q13A）**：新增 `agent_profiles` 表：`key / display_name / description / prompt_key / tool_whitelist / engine_kind（qa_graph | agentdesk_bridge | runtime） / default_mode / model_policy / enabled`。**prompt 不内嵌**——`prompt_key` 指向 prompts 发布体系（ADR-010），无发布版本时代码默认兜底。一期 seed 两个：`knowledge-assistant`（prompt_key=`chat_qa`，engine=qa_graph，现有会话零迁移）、`code-engineer`（engine=agentdesk_bridge，一期用 agentdesk 图内置模板）。
2. **模型策略（Q14A）**：profile 携带 `model_policy = {primary, fallbacks: []}`，缺省回落全局 `MODEL_CHAT_MODEL` 映射。Error Recovery 一期实现：模型调用失败 → 限次重试 → fallback 链换模型；审计与 usage 记录实际命中模型。
3. **Permission 泛化时机（Q15A）**：一期不动 `agentdesk/policy.py`，桥接层直连现有求值与审批端点；二期自研内核开工时抽取 `agent_runtime/permission.py`（声明式 PermissionRule + 审批管线 + hooks 挂点），golden 测试锁行为等价。否决各域各写（两条审批管线行为漂移、审计口径分裂）。
4. **`/agentdesk.html` 退役（Q16A）**：两段式——二期自研内核接管 `code-engineer` 且 hunk 评审 + commit 门禁卡片迁入聊天流后转**只读归档**（仅查看历史任务）；三期随 MCP/Teams 稳定后删除。删除绑定「卡片功能平价」达成，不绑日期。
5. **测试与评测（Q17A）**：CI 单测覆盖桥接层（chat ↔ agentdesk API、`chat_messages` 落库、审批卡片 resume、SSE 信封），模型层 mock（ADR-012 口径）；`evals/golden_set.jsonl` 增 workbench 冒烟 golden（需真实 key，本地手动跑、CI 跳过，沿用 `test_eval_regression.py` 机制）。
6. **Task System 持久化（Q18A）**：**TaskRecord 落 PG**（`blocked_by` 外键链 + 租约协同），磁盘仅工作区。裁决说明：能力清单中「磁盘持久化」源自单机 CLI Agent 工具的世界观（用户自认抄录未审），本平台是多用户服务（租约恢复、审计合规、SKIP LOCKED 并发认领均为 PG 先决能力），磁盘持久化在容器重启/多副本下不可用——按平台世界观修正。另：平台向量能力 = PG + pgvector（无独立向量库），后续 Memory/检索类能力默认同域。

## 后果

**正面**：prompt/模型/权限三大治理面均复用既有体系零平行建设；退役路径以功能平价为闸门，可验收。

**负面/风险**：一期 bridge 的 engine_kind 枚举是过渡态字段，内核吸收后需迁移语义（profile 不动、枚举值收敛到 runtime）；golden set 依赖真实 key，CI 与本地的评测覆盖口径长期不一致。
