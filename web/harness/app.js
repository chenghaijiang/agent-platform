/**
 * Agent Harness — native web client (no framework, no build step).
 *
 * The UI is a thin surface over the protocol server: it renders SSE events, POSTs turns and
 * approvals, and mirrors the server's derived snapshot on the right panel. There is no client
 * side agent logic — every fact shown here comes from the server.
 */
"use strict";

import { renderMarkdown } from "./markdown.js";

// ===== 平台集成（ADR-019）：认证网关前缀 + Bearer 注入 =====
// harness 原生直连协议服务器；平台形态下所有请求经 FastAPI 认证网关反代（/api/harness/*），
// 并携带知源登录态（localStorage zs_token，与统一工作台同源）。EventSource 无法自定义
// header，SSE 连接同样走 fetch 流式（见 connect()）。
const API_BASE = "/api/harness";

function authHeaders() {
  const token = localStorage.getItem("zs_token") || "";
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// 统一请求入口：网关前缀 + 认证头 + 401 回平台登录页（与知源统一工作台同款行为）
async function hw(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (res.status === 401) {
    window.location.href = "/";
    throw new Error("登录已失效，请重新登录");
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// constants & helpers
// ---------------------------------------------------------------------------------------------

const PHASES = [
  { key: "processing_input", label: "ProcessingInput" },
  { key: "awaiting_model", label: "AwaitingModel" },
  { key: "streaming", label: "Streaming" },
  { key: "scheduling_tools", label: "SchedulingTools" },
  { key: "awaiting_permission", label: "AwaitingPermission" },
  { key: "executing_tools", label: "ExecutingTools" },
  { key: "aggregating_results", label: "AggregatingResults" },
  { key: "completing", label: "Completing" },
];

const OUTPUT_PREVIEW_CHARS = 200;
const MAX_RECONNECT_ATTEMPTS = 5;

const $ = (id) => document.getElementById(id);

const dom = {
  envBadge: $("env-badge"),
  conn: $("conn"),
  connText: $("conn-text"),
  modelChip: $("model-chip"),
  modeToggle: $("mode-toggle"),
  sessionList: $("session-list"),
  newTask: $("new-task"),
  sessionTitle: $("session-title"),
  phaseChip: $("phase-chip"),
  phaseText: $("phase-text"),
  traceMini: $("trace-mini"),
  chat: $("chat"),
  composer: $("composer"),
  sendBtn: $("send-btn"),
  inputHint: $("input-hint"),
  ctxUsed: $("ctx-used"),
  segSystem: $("seg-system"),
  segMemory: $("seg-memory"),
  segHistory: $("seg-history"),
  segObservations: $("seg-observations"),
  legSystem: $("leg-system"),
  legMemory: $("leg-memory"),
  legHistory: $("leg-history"),
  legObservations: $("leg-observations"),
  compactNote: $("compact-note"),
  phaseList: $("phase-list"),
  approvals: $("approvals"),
  approvalsEmpty: $("approvals-empty"),
  subagents: $("subagents"),
  subagentsEmpty: $("subagents-empty"),
  statTurns: $("stat-turns"),
  statTools: $("stat-tools"),
  statWaves: $("stat-waves"),
  traceId: $("trace-id"),
  agentId: $("agent-id"),
  qdrantState: $("qdrant-state"),
  toast: $("toast"),
  kbBtn: $("kb-btn"),
  kbCount: $("kb-count"),
  skillsBtn: $("skills-btn"),
  skillsCount: $("skills-count"),
  filesBtn: $("files-btn"),
  dataBtn: $("data-btn"),
  composer: $("composer"),
  inputWrap: document.querySelector(".input-wrap"),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function nowLabel() {
  return timeLabel(Date.now());
}

function timeLabel(timestamp) {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatK(value) {
  const n = Number(value) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n);
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Thinking models may emit <think> blocks; keep them out of the visible chat. */
function stripThink(text) {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const open = out.lastIndexOf("<think>");
  if (open !== -1) out = out.slice(0, open);
  return out.replace(/^\s+/, "");
}

function oneLine(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

let toastTimer = null;
function toast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 3600);
}

// ---------------------------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------------------------

const ui = {
  busy: false,
  phase: null,
  traceId: "",
  connection: "connecting",
  turn: 0,
  staleAttempts: 0,
  /** 智能体（工具可用）vs 智能问答（纯对话）— mirrored from the server snapshot. */
  agentMode: true,
};

/** Reflect the mode on the header toggle. */
function setModeToggle(enabled) {
  ui.agentMode = Boolean(enabled);
  dom.modeToggle.textContent = ui.agentMode ? "🤖 智能体" : "💬 智能问答";
  dom.modeToggle.classList.toggle("chat-mode", !ui.agentMode);
}

// ---------------------------------------------------------------------------------------------
// sessions — metadata persisted in localStorage; chat content rebuilds from the server
// transcript (SSE replay routes events to their session via traceId).
// ---------------------------------------------------------------------------------------------

const SESSIONS_LS_KEY = "harness.sessions.v1";

let sessionSeq = 0;
const sessions = [];
let activeSession = null;

/** Persist session metadata only (title/createdAt/traceIds) — DOM streams are rebuilt from replay. */
function persistSessions() {
  try {
    const list = sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      traceIds: [...s.traceIds],
    }));
    localStorage.setItem(SESSIONS_LS_KEY, JSON.stringify(list));
  } catch {
    /* private mode / quota — sessions stay in-memory only */
  }
}

function loadPersistedSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_LS_KEY);
    if (!raw) return null;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return null;
    return list.filter((s) => s && typeof s.id === "string" && typeof s.title === "string");
  } catch {
    return null;
  }
}

function createSession(title = "新任务", saved = null) {
  const stream = el("div", "chat-stream");
  // Restore the persisted id/seq when rebuilding the session list after a refresh.
  if (saved) {
    const n = Number.parseInt(String(saved.id).slice(1), 10);
    if (Number.isFinite(n) && n > sessionSeq) sessionSeq = n;
  }
  const session = {
    id: saved?.id ?? `s${++sessionSeq}`,
    title: saved?.title ?? title,
    stream,
    createdAt: saved?.createdAt ?? Date.now(),
    traceIds: new Set(saved?.traceIds ?? []),
    turnGroup: null,
    plan: null,
    waves: new Map(),
    cards: new Map(),
    live: null,
  };
  sessions.push(session);
  persistSessions();
  renderSessionList();
  if (!saved) activateSession(session);
  return session;
}

/** Route an event to its session by traceId; unknown traces fall back to the live session. */
function sessionForTrace(traceId) {
  if (traceId) {
    for (const session of sessions) {
      if (session.traceIds.has(traceId)) return session;
    }
  }
  return liveSession();
}

function ensureLiveSession() {
  const live = sessions[sessions.length - 1];
  if (live && live !== activeSession) activateSession(live);
  return live;
}

/** The newest session owns the live runtime; events always land there, viewed or not. */
function liveSession() {
  return sessions[sessions.length - 1] ?? null;
}

function activateSession(session) {
  if (!session) return;
  activeSession = session;
  dom.chat.replaceChildren(session.stream);
  dom.sessionTitle.textContent = session.title;
  renderSessionList();
  dom.chat.scrollTop = dom.chat.scrollHeight;
  dom.composer.focus();
}

function renderSessionList() {
  dom.sessionList.replaceChildren();
  for (const session of sessions) {
    const item = el("button", `session-item${session === activeSession ? " active" : ""}`);
    item.type = "button";
    item.append(el("span", "icon", "💬"));
    item.append(el("span", "title", session.title));
    item.append(el("span", "time", timeLabel(session.createdAt)));
    item.addEventListener("click", () => activateSession(session));
    dom.sessionList.append(item);
  }
}

function updateSessionTitle(session, text) {
  if (session.title !== "新任务") return;
  session.title = oneLine(text, 28);
  persistSessions();
  if (session === activeSession) dom.sessionTitle.textContent = session.title;
  renderSessionList();
}

// ---------------------------------------------------------------------------------------------
// message / turn rendering
// ---------------------------------------------------------------------------------------------

function ensureTurn(session) {
  if (session.turnGroup) return session.turnGroup;
  const group = el("div", "turn");
  session.stream.append(group);
  session.turnGroup = group;
  session.plan = null;
  session.waves.clear();
  session.cards.clear();
  session.live = null;
  return group;
}

function scrollIfNearBottom() {
  const gap = dom.chat.scrollHeight - dom.chat.scrollTop - dom.chat.clientHeight;
  if (gap < 140) dom.chat.scrollTop = dom.chat.scrollHeight;
}

function addUserMessage(session, text) {
  const group = ensureTurn(session);
  const wrap = el("div", "msg user");
  wrap.append(el("div", "msg-avatar", "你"));
  const body = el("div", "msg-body");
  const meta = el("div", "msg-meta");
  meta.append(el("span", null, "你"), el("span", null, nowLabel()));
  const content = el("div", "msg-content", text);
  body.append(meta, content);
  wrap.append(body);
  group.append(wrap);
  scrollIfNearBottom();
}

function addAgentBubble(session) {
  const group = ensureTurn(session);
  const wrap = el("div", "msg agent");
  wrap.append(el("div", "msg-avatar", "A"));
  const body = el("div", "msg-body");
  const meta = el("div", "msg-meta");
  meta.append(el("span", null, "Agent"), el("span", null, nowLabel()));
  const content = el("div", "msg-content", "");
  body.append(meta, content);
  wrap.append(body);
  group.append(wrap);
  return { wrap, content, meta };
}

function addErrorNote(session, message) {
  const note = el("div", "msg-error", message);
  (session.turnGroup ?? ensureTurn(session)).append(note);
}

function onDelta(session, text) {
  if (!session) return;
  if (!session.live) session.live = { ...addAgentBubble(session), raw: "" };
  session.live.raw += text;
  session.live.content.innerHTML = renderMarkdown(stripThink(session.live.raw));
  scrollIfNearBottom();
}

function onAssistantMessage(session, text) {
  if (!session) return;
  const visible = stripThink(text);
  if (visible) {
    const bubble = session.live ?? addAgentBubble(session);
    bubble.content.innerHTML = renderMarkdown(visible);
    session.live = null;
  } else if (session.live) {
    session.live.wrap.remove();
    session.live = null;
  }
  scrollIfNearBottom();
}

// ---------------------------------------------------------------------------------------------
// plan card (derived from the real wave plan the runtime scheduled)
// ---------------------------------------------------------------------------------------------

function setStep(step, state) {
  step.state = state;
  step.row.className = `plan-step ${state}`;
  step.check.className = `step-check ${state}`;
  step.check.textContent = state === "done" ? "✓" : state === "running" ? "…" : "•";
}

function addPlanStep(plan, text) {
  const row = el("div", "plan-step");
  const check = el("div", "step-check todo", "•");
  const label = el("div", "step-text", text);
  const count = el("div", "step-count", "");
  row.append(check, label, count);
  plan.list.append(row);
  const step = { row, check, label, count, state: "todo" };
  return step;
}

function ensurePlan(session) {
  if (session.plan) return session.plan;
  const group = ensureTurn(session);
  const card = el("div", "plan-card");
  card.append(el("h4", null, "🗺️ 本轮执行计划"));
  const list = el("div");
  card.append(list);
  group.append(card);
  const plan = { card, list, steps: [], reasoning: null, waveSteps: new Map() };
  plan.reasoning = addPlanStep(plan, "模型推理 · 决策下一步动作");
  setStep(plan.reasoning, "running");
  session.plan = plan;
  return plan;
}

function finishPlan(session) {
  const plan = session.plan;
  if (!plan) return;
  for (const step of plan.steps) if (step.state === "running") setStep(step, "done");
}

// ---------------------------------------------------------------------------------------------
// tool cards
// ---------------------------------------------------------------------------------------------

function waveGroup(session, wave, parallel) {
  const existing = session.waves.get(wave);
  if (existing) return existing;

  const group = ensureTurn(session);
  const plan = ensurePlan(session);
  if (plan.reasoning && plan.reasoning.state === "running") setStep(plan.reasoning, "done");

  // Collapsed by default: one quiet summary line; click to expand the tool cards.
  const summary = el("button", "wave-summary running", "");
  summary.type = "button";
  summary.addEventListener("click", () => {
    body.hidden = !body.hidden;
    summary.classList.toggle("open", !body.hidden);
  });

  const label = el(
    "div",
    "wave-label",
    `${parallel ? "⚡" : "🔒"} Wave ${wave + 1} — ${parallel ? "并行（并行安全工具）" : "串行（含破坏性/外部工具）"}`,
  );
  const row = el("div", "wave");
  const body = el("div", "wave-body");
  body.hidden = true;
  body.append(label, row);
  group.append(summary, body);

  const step = addPlanStep(plan, `${parallel ? "⚡" : "🔒"} Wave ${wave + 1}`);
  setStep(step, "running");
  step.count.textContent = "0 个工具";

  const entry = { label, row, body, summary, parallel, calls: 0, done: 0, step, failed: 0, msTotal: 0 };
  session.waves.set(wave, entry);
  plan.waveSteps.set(wave, step);
  updateWaveSummary(entry);
  return entry;
}

/** Keep the collapsed wave line current: progress → outcome (+ duration). */
function updateWaveSummary(entry) {
  const parts = [`⚙ ${entry.done}/${entry.calls} 个工具`];
  if (entry.done < entry.calls) parts.push("运行中…");
  else if (entry.failed > 0) parts.push(`${entry.failed} 个失败`);
  else parts.push("全部 OK");
  if (entry.msTotal > 0) parts.push(formatDuration(entry.msTotal));
  entry.summary.textContent = parts.join(" · ");
  entry.summary.classList.toggle("running", entry.done < entry.calls);
  entry.summary.classList.toggle("has-error", entry.failed > 0);
}

function addToolCard(session, event) {
  const group = waveGroup(session, event.wave, event.parallel);
  group.calls++;
  group.step.count.textContent = `${group.done}/${group.calls} 个工具`;

  const card = el("div", "tool-card");
  card.dataset.callId = event.callId;

  const header = el("div", "tool-card-header");
  header.append(
    el("span", `wave-badge ${event.parallel ? "par" : "ser"}`, `${event.parallel ? "⚡" : "🔒"}W${event.wave + 1}`),
    el("span", "tool-name", event.tool),
  );
  const status = el("span", "tool-status running", "RUNNING");
  const duration = el("span", "tool-dur", "");
  header.append(status, duration);

  const input = el("div", "tool-input", "");
  const toggle = el("button", "tool-output-toggle", "输出");
  toggle.type = "button";
  toggle.hidden = true;
  const output = el("pre", "tool-output", "");
  output.hidden = true;

  toggle.addEventListener("click", () => {
    output.hidden = !output.hidden;
    if (!output.hidden) output.scrollTop = 0;
  });

  card.append(header, input, toggle, output);
  group.row.append(card);
  session.cards.set(event.callId, { card, status, duration, input, toggle, output, group });
  updateWaveSummary(group);
  scrollIfNearBottom();
}

function setToolInput(session, callId, text) {
  const card = session.cards.get(callId);
  if (!card) return;
  card.input.textContent = `入参 ${text}`;
}

function finishToolCall(session, event) {
  const card = session.cards.get(event.callId);
  if (!card) return;
  const status = String(event.status || "error").toLowerCase();
  card.status.className = `tool-status ${status}`;
  card.status.textContent = status === "ok" ? "OK" : status === "denied" ? "DENIED" : status === "timeout" ? "TIMEOUT" : "ERROR";
  card.duration.textContent = formatDuration(event.durationMs);

  card.group.done++;
  if (status !== "ok") card.group.failed++;
  card.group.msTotal += Number(event.durationMs) || 0;
  card.group.step.count.textContent = `${card.group.done}/${card.group.calls} 个工具`;
  if (card.group.done >= card.group.calls) setStep(card.group.step, "done");
  updateWaveSummary(card.group);
}

function setToolOutput(session, event) {
  const card = session.cards.get(event.callId);
  if (!card) return;
  const text = String(event.output ?? "");
  const preview = text.slice(0, OUTPUT_PREVIEW_CHARS);
  card.output.textContent = text.length > OUTPUT_PREVIEW_CHARS ? `${preview}\n…（共 ${text.length} 字符）` : preview;
  card.toggle.hidden = false;
  card.toggle.textContent = text.length > OUTPUT_PREVIEW_CHARS
    ? `输出（前 ${OUTPUT_PREVIEW_CHARS} 字 / 共 ${text.length} 字）`
    : `输出（${text.length} 字）`;
}

// ---------------------------------------------------------------------------------------------
// turn lifecycle
// ---------------------------------------------------------------------------------------------

const REASON_LABELS = {
  goal_completed: "完成",
  max_iterations_reached: "达到迭代上限",
  needs_user_decision: "需要用户决策",
  guardrail_rejected: "护栏拒绝",
  user_interrupted: "已中断",
  error: "出错",
};

/**
 * Rebuild the chat from the server's transcript (SSE "replay", sent before live events).
 * Deltas are not replayed — final `message_appended` events already carry the full text.
 * Events route to their session via traceId; each session's stream is reset first so a
 * reconnect (replay re-sent on every SSE open) does not duplicate content.
 */
function restoreTranscript(entries) {
  for (const session of sessions) {
    session.stream.replaceChildren();
    session.turnGroup = null;
    session.plan = null;
    session.waves.clear();
    session.cards.clear();
    session.live = null;
  }

  for (const entry of entries) {
    if (!entry || typeof entry.kind !== "string") continue;
    switch (entry.kind) {
      case "session":
        onSessionEvent(entry.payload);
        break;
      case "tool_input":
        setToolInput(sessionForEvent(entry.payload), entry.payload?.callId, entry.payload?.input ?? "");
        break;
      case "tool_result":
        setToolOutput(sessionForEvent(entry.payload), entry.payload);
        break;
      case "turn":
        onTurnFinished(entry.payload);
        break;
      case "compaction":
        break; // restored once below (only the latest note matters)
      default:
        break;
    }
  }

  const lastCompact = [...entries].reverse().find((e) => e?.kind === "compaction");
  if (lastCompact?.payload) {
    const p = lastCompact.payload;
    dom.compactNote.hidden = false;
    dom.compactNote.textContent = `⚡ ${p.level}-compact：${p.tokensBefore} → ${p.tokensAfter} tokens`;
  }

  if (activeSession) {
    dom.sessionTitle.textContent = activeSession.title;
    dom.chat.scrollTop = dom.chat.scrollHeight;
  }
  renderSessionList();
}

/** tool_input/tool_result payloads carry traceId (new) — fall back to the live session otherwise. */
function sessionForEvent(payload) {
  const session = sessionForTrace(payload?.traceId);
  return session ?? liveSession();
}

function onSessionEvent(event) {
  if (!event || typeof event.type !== "string") return;
  const session = sessionForEvent(event);
  if (!session) return;

  switch (event.type) {
    case "user_message": {
      // The user bubble is rendered from this server event (also replayed after refresh),
      // so submitTurn no longer draws it locally.
      addUserMessage(session, event.text ?? "");
      updateSessionTitle(session, event.text ?? "");
      break;
    }
    case "turn_started": {
      const group = ensureTurn(session);
      const marker = el("div", "turn-marker", `TURN · trace ${event.traceId}`);
      group.prepend(marker);
      ui.turn++;
      break;
    }
    case "phase_changed":
      ui.phase = event.to;
      break;
    case "message_appended": {
      if (event.message.role !== "assistant") break;
      const text = (event.message.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      onAssistantMessage(session, text);
      break;
    }
    case "tool_call_started":
      addToolCard(session, event);
      break;
    case "tool_call_finished":
      finishToolCall(session, event);
      break;
    case "compaction_triggered":
      dom.compactNote.hidden = false;
      dom.compactNote.textContent = `⚡ ${event.level}-compact：${event.tokensBefore} → ${event.tokensAfter} tokens`;
      break;
    default:
      break;
  }
}

function onTurnFinished(payload) {
  const session = sessionForEvent(payload);
  if (session && session.turnGroup) {
    const footer = el("div", "turn-footer");
    footer.append(
      el("b", null, REASON_LABELS[payload.reason] ?? payload.reason ?? "结束"),
      el("span", null, `${payload.iterations ?? 0} iterations`),
      el("span", null, formatDuration(payload.durationMs)),
    );
    if (payload.reason === "error" && payload.text) {
      footer.append(el("span", null, oneLine(payload.text, 100)));
    }
    session.turnGroup.append(footer);
    finishPlan(session);
    session.turnGroup = null;
    session.plan = null;
    session.waves = new Map();
    session.cards = new Map();
    session.live = null;
  }
  ui.busy = false;
  ui.phase = null;
  renderComposer();
  scrollIfNearBottom();
}

// ---------------------------------------------------------------------------------------------
// right panel
// ---------------------------------------------------------------------------------------------

let phaseRows = null;

function buildPhaseRows() {
  dom.phaseList.replaceChildren();
  phaseRows = PHASES.map((phase, index) => {
    const item = el("div", "phase-item");
    const rail = el("div", "phase-rail");
    const node = el("div", "phase-node");
    const line = el("div", "phase-line");
    rail.append(node, line);
    const name = el("span", "phase-name", phase.label);
    const duration = el("span", "phase-dur", "—");
    item.append(rail, name, duration);
    dom.phaseList.append(item);
    return { item, node, line, name, duration, isLast: index === PHASES.length - 1 };
  });
}

function renderPhases(phases, current) {
  if (!phaseRows) buildPhaseRows();
  const byPhase = new Map();
  for (const entry of phases ?? []) byPhase.set(entry.phase, entry);

  let previousDone = false;
  phaseRows.forEach((row, index) => {
    const entry = byPhase.get(PHASES[index].key);
    const state = entry?.state ?? (current === PHASES[index].key ? "active" : "pending");
    row.item.className = `phase-item ${state === "pending" ? "" : state}`;
    row.node.className = `phase-node ${state === "pending" ? "" : state}`;
    row.line.className = `phase-line ${previousDone ? "done" : ""}`;
    row.line.style.visibility = row.isLast ? "hidden" : "visible";
    row.duration.textContent =
      state === "active" ? "…" : state === "done" ? formatDuration(entry?.durationMs) : "—";
    previousDone = state === "done";
  });

  const busy = ui.busy;
  dom.phaseChip.className = `turn-phase${busy && current ? "" : " idle"}`;
  dom.phaseText.textContent = busy && current ? `TURN · ${String(current).toUpperCase()}` : "IDLE";
}

function renderContext(context) {
  if (!context) return;
  const window = context.window || 1;
  const segments = context.segments || {};
  const share = (value) => `${Math.max(0, Math.min(100, ((value || 0) / window) * 100)).toFixed(1)}%`;

  dom.segSystem.style.width = share(segments.system);
  dom.segMemory.style.width = share(segments.memory);
  dom.segHistory.style.width = share(segments.history);
  dom.segObservations.style.width = share(segments.observations);

  dom.ctxUsed.textContent = `${formatK(context.used)} / ${formatK(window)}（${context.percent ?? 0}%）`;
  dom.legSystem.textContent = share(segments.system);
  dom.legMemory.textContent = share(segments.memory);
  dom.legHistory.textContent = share(segments.history);
  dom.legObservations.textContent = share(segments.observations);
}

function renderApprovals(approvals) {
  dom.approvals.replaceChildren();
  const list = approvals ?? [];
  dom.approvalsEmpty.hidden = list.length > 0;

  for (const approval of list) {
    const card = el("div", "perm-card");
    card.append(el("div", "perm-title", `⚠️ ${approval.level} 操作请求`));
    const cmd = el("div", "perm-cmd");
    cmd.append(el("div", null, approval.tool));
    cmd.append(el("div", "perm-input", approval.input || "(无入参)"));
    card.append(cmd);

    const buttons = el("div", "perm-btns");
    const allow = el("button", "btn primary", "✓ 允许");
    const always = el("button", "btn always", "总是允许");
    const deny = el("button", "btn danger", "✕ 拒绝");
    for (const btn of [allow, always, deny]) btn.type = "button";
    allow.addEventListener("click", () => decide(approval.requestId, "allowed", buttons));
    always.addEventListener("click", () => decide(approval.requestId, "always", buttons));
    deny.addEventListener("click", () => decide(approval.requestId, "denied", buttons));
    buttons.append(allow, always, deny);
    card.append(buttons);
    dom.approvals.append(card);
  }
}

async function decide(requestId, decision, buttons) {
  for (const btn of buttons.querySelectorAll("button")) btn.disabled = true;
  try {
    const res = await hw("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      toast(payload?.error?.message ?? `审批失败（HTTP ${res.status}）`);
    }
  } catch {
    toast("审批请求发送失败");
  }
}

function renderSubagents(subagents) {
  dom.subagents.replaceChildren();
  const list = subagents ?? [];
  dom.subagentsEmpty.hidden = list.length > 0;

  for (const agent of list) {
    const row = el("div", "subagent");
    row.append(el("div", "subagent-icon", agent.profile === "explore" ? "🔍" : "🧪"));
    const info = el("div", "subagent-info");
    info.append(el("div", "subagent-name", agent.profile));
    const meta = [agent.id, agent.worktree ? "worktree" : null, agent.status === "running" ? "运行中" : "已完成"]
      .filter(Boolean)
      .join(" · ");
    info.append(el("div", "subagent-status", meta));
    row.append(info);
    row.append(el("span", `subagent-badge ${agent.background ? "bg" : "fg"}`, agent.background ? "后台" : "前台"));
    dom.subagents.append(row);
  }
}

function renderStats(stats) {
  if (!stats) return;
  dom.statTurns.textContent = String(stats.turns ?? 0);
  dom.statTools.textContent = String(stats.toolCalls ?? 0);
  dom.statWaves.textContent = String(stats.parallelWaves ?? 0);
}

function renderHealth(health) {
  if (!health) return;
  dom.envBadge.textContent = health.ok ? "● Runtime ready" : "● Runtime degraded";
  dom.envBadge.className = `env-badge${health.ok ? "" : " degraded"}`;
  dom.envBadge.title = health.hint ?? "";
  dom.modelChip.textContent = `${health.model} · ${formatK(health.contextWindow)} ctx`;
  dom.modelChip.title = `${health.provider}${health.toolCalling ? "" : "（不支持 tool calling）"}`;
  dom.qdrantState.textContent = health.qdrant ?? "unknown";
  dom.qdrantState.style.color = health.qdrant === "online" ? "var(--green)" : "var(--red)";
}

function applyState(snapshot) {
  if (!snapshot) return;
  if (typeof snapshot.agentMode === "boolean") setModeToggle(snapshot.agentMode);
  ui.busy = Boolean(snapshot.busy);
  ui.traceId = snapshot.traceId || "";
  ui.phase = snapshot.phase ?? null;
  ui.turn = snapshot.stats?.turns ?? ui.turn;

  renderHealth(snapshot.health);
  renderContext(snapshot.context);
  renderPhases(snapshot.phases, snapshot.phase);
  renderApprovals(snapshot.approvals);
  renderSubagents(snapshot.subagents);
  renderStats(snapshot.stats);
  renderComposer();

  dom.traceId.textContent = ui.traceId || "—";
  dom.traceMini.textContent = `trace: ${ui.traceId || "—"}`;
  dom.agentId.textContent = snapshot.agentId || "—";
}

function renderComposer() {
  if (ui.busy) {
    dom.sendBtn.textContent = "中断";
    dom.sendBtn.className = "send-btn cancel";
    dom.sendBtn.title = "中断当前 turn（POST /api/cancel）";
    dom.inputHint.textContent = "运行中 · 点击「中断」停止当前 turn";
  } else {
    dom.sendBtn.textContent = "↑";
    dom.sendBtn.className = "send-btn";
    dom.sendBtn.title = "发送（Enter）";
    dom.inputHint.textContent = "Enter 发送 · Shift+Enter 换行";
  }
}

// ---------------------------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------------------------

async function submitTurn() {
  const text = dom.composer.value.trim();
  if (!text || ui.busy) return;

  const session = ensureLiveSession();
  // The user bubble is rendered from the server's user_message event (replay-safe);
  // only the title is updated locally for immediate feedback.
  updateSessionTitle(session, text);
  dom.composer.value = "";
  autoResize();

  try {
    const res = await hw("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload?.error?.message ?? `发送失败（HTTP ${res.status}）`;
      addErrorNote(session, message);
      toast(message);
      return;
    }
    // Bind this turn to the session that sent it — replay and live events route by traceId.
    if (payload?.traceId) {
      session.traceIds.add(payload.traceId);
      persistSessions();
    }
    ui.busy = true;
    renderComposer();
    scrollIfNearBottom();
  } catch {
    addErrorNote(session, "无法连接协议服务器");
    toast("无法连接协议服务器");
  }
}

async function cancelTurn() {
  try {
    const res = await hw("/api/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 501) {
      toast("当前 core 尚未提供 cancel 能力，turn 会继续执行");
      return;
    }
    if (!res.ok) {
      toast(payload?.error?.message ?? `中断失败（HTTP ${res.status}）`);
      return;
    }
    toast(payload.cancelled ? "已请求中断" : "当前没有运行中的 turn");
  } catch {
    toast("中断请求发送失败");
  }
}

function autoResize() {
  dom.composer.style.height = "auto";
  dom.composer.style.height = `${Math.min(160, dom.composer.scrollHeight)}px`;
}

// ---------------------------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------------------------

let source = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualClose = false;

function setConnection(kind, note) {
  ui.connection = kind;
  dom.conn.className = `conn ${kind}`;
  dom.connText.textContent =
    kind === "connected" ? "已连接" : kind === "reconnecting" ? "重连中" : "已断开";
  dom.conn.title = note ?? "SSE 连接状态（点击手动重连）";
}

// 平台集成（ADR-019）：EventSource 无法携带 Authorization，改为 fetch 流式消费 SSE
// （与知源统一工作台同模式）；source 语义从 EventSource 变为 AbortController。
function connect() {
  clearTimeout(reconnectTimer);
  if (source) {
    manualClose = true;
    source.abort();
    source = null;
    manualClose = false;
  }

  setConnection("reconnecting", "建立 SSE 连接…");
  const controller = new AbortController();
  source = controller;

  void (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/events`, {
        headers: { Accept: "text/event-stream", ...authHeaders() },
        signal: controller.signal,
      });
      if (res.status === 401) {
        window.location.href = "/";
        return;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      reconnectAttempts = 0;
      setConnection("connected");

      // SSE 文本协议解析：event:/data: 行，空行分发；server 端心跳为 `: ping` 注释行
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          dispatchSseFrame(frame);
        }
      }
      // 服务器侧断开（重启/网络）→ 走既有指数退避重连
      if (source === controller && !manualClose) {
        source = null;
        scheduleReconnect();
      }
    } catch (err) {
      if (manualClose || err.name === "AbortError") return;
      if (source === controller) {
        source = null;
        scheduleReconnect();
      }
    }
  })();
}

// 原生 EventSource addEventListener 的等价分发表（fetch 流式无事件名 API）
const sseHandlers = {
  replay: (payload) => {
    if (Array.isArray(payload) && payload.length) restoreTranscript(payload);
  },

  state: (payload) => {
    if (payload) applyState(payload);
  },

  session: (payload) => {
    if (payload) onSessionEvent(payload);
  },

  delta: (payload) => {
    const session = sessionForEvent(payload);
    if (payload && session) onDelta(session, payload.text ?? "");
  },

  tool_input: (payload) => {
    const session = sessionForEvent(payload);
    if (payload && session) setToolInput(session, payload.callId, payload.input ?? "");
  },

  tool_result: (payload) => {
    const session = sessionForEvent(payload);
    if (payload && session) setToolOutput(session, payload);
  },

  approval: () => {
    /* the state snapshot already carries the approval card */
  },

  approval_resolved: () => {
    /* ditto */
  },

  turn: (payload) => {
    if (payload) onTurnFinished(payload);
  },

  compaction: (payload) => {
    if (!payload) return;
    dom.compactNote.hidden = false;
    dom.compactNote.textContent = `⚡ ${payload.level}-compact：${payload.tokensBefore} → ${payload.tokensAfter} tokens`;
  },
};

function dispatchSseFrame(frame) {
  let name = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // 心跳/注释行
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  const handler = sseHandlers[name];
  if (!handler) return;
  const raw = dataLines.join("\n");
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }
  handler(payload);
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    setConnection("disconnected", "重连失败，点击手动重连");
    return;
  }
  const delay = Math.min(8000, 500 * 2 ** reconnectAttempts);
  reconnectAttempts++;
  setConnection("reconnecting", `第 ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} 次重连，${delay}ms 后重试`);
  reconnectTimer = setTimeout(connect, delay);
}

// ---------------------------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------------------------

function bindEvents() {
  dom.sendBtn.addEventListener("click", () => {
    if (ui.busy) void cancelTurn();
    else void submitTurn();
  });

  dom.composer.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submitTurn();
    }
  });
  dom.composer.addEventListener("input", autoResize);

  dom.newTask.addEventListener("click", () => {
    createSession("新任务");
    dom.composer.value = "";
    autoResize();
  });

  dom.conn.addEventListener("click", () => {
    reconnectAttempts = 0;
    connect();
  });

  dom.modelChip.addEventListener("click", () => {
    void toggleModelPicker();
  });

  // 智能体 / 智能问答 toggle: optimistic flip, SSE state push confirms with the server value.
  dom.modeToggle.addEventListener("click", async () => {
    const target = !ui.agentMode;
    setModeToggle(target);
    try {
      const res = await hw("/api/agent-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: target }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setModeToggle(body.agentMode);
      toast(body.agentMode ? "🤖 已切换到智能体模式（工具可用）" : "💬 已切换到智能问答模式（纯对话）");
    } catch (err) {
      setModeToggle(ui.agentMode); // revert on failure
      toast(`切换失败：${err.message}`);
    }
  });

  dom.kbBtn.addEventListener("click", () => {
    void toggleKbPanel();
  });

  dom.skillsBtn.addEventListener("click", () => {
    void toggleSkillsPanel();
  });

  dom.filesBtn.addEventListener("click", () => {
    void openWorkspacePanel();
  });

  dom.dataBtn.addEventListener("click", () => {
    void openDataPanel();
  });

  // §10.1: "/" in an empty composer opens the slash-command autocomplete.
  dom.composer.addEventListener("input", () => {
    updateSlashAutocomplete();
  });
  dom.composer.addEventListener("keydown", (e) => {
    if (!slashBox) return;
    if (e.key === "Escape") {
      closeSlashAutocomplete();
      e.preventDefault();
    } else if (e.key === "Enter" && !e.isComposing && slashBoxActive) {
      e.preventDefault();
      applySlashChoice(slashBoxActive);
    }
  });

  document.querySelectorAll("[data-placeholder]").forEach((node) => {
    node.addEventListener("click", () => toast(`${node.dataset.placeholder}：占位入口，尚未接入`));
  });
}

// ---------------------------------------------------------------------------------------------
// slash autocomplete (§10.1) — composer starts with "/" → skill command menu
// ---------------------------------------------------------------------------------------------

let slashBox = null;
let slashBoxActive = null; // currently highlighted SkillManifest
let skillsCache = [];

function closeSlashAutocomplete() {
  slashBox?.remove();
  slashBox = null;
  slashBoxActive = null;
}

async function updateSlashAutocomplete() {
  const value = dom.composer.value;
  if (!value.startsWith("/") || value.includes("\n")) {
    closeSlashAutocomplete();
    return;
  }
  const partial = value.trim().toLowerCase();
  if (!skillsCache.length) {
    try {
      const res = await hw("/api/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      skillsCache = (await res.json()).skills ?? [];
    } catch {
      closeSlashAutocomplete();
      return;
    }
  }
  const matches = skillsCache.filter(
    (s) => s.slash.toLowerCase().startsWith(partial) || s.name.toLowerCase().startsWith(partial.slice(1)),
  );
  if (!matches.length) {
    closeSlashAutocomplete();
    return;
  }

  closeSlashAutocomplete();
  const box = el("div", "slash-box");
  slashBoxActive = matches[0];
  matches.forEach((skill, i) => {
    const item = el("button", `slash-item${i === 0 ? " active" : ""}`);
    item.type = "button";
    item.append(
      el("span", "slash-cmd", skill.slash),
      el("span", "slash-desc", `${skill.description}${skill.argumentHint ? ` · ${skill.argumentHint}` : ""}`),
    );
    item.addEventListener("click", () => applySlashChoice(skill));
    item.addEventListener("mouseenter", () => {
      box.querySelectorAll(".slash-item").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      slashBoxActive = skill;
    });
    box.append(item);
  });
  dom.inputWrap.append(box);
  slashBox = box;
}

function applySlashChoice(skill) {
  dom.composer.value = `${skill.slash} `;
  closeSlashAutocomplete();
  dom.composer.focus();
  dom.composer.dispatchEvent(new Event("input"));
}

// ---------------------------------------------------------------------------------------------
// model picker (GET /api/models · POST /api/model — runtime hot-swap with carried history)
// ---------------------------------------------------------------------------------------------

let modelPicker = null;
let modelPickerCloser = null;

function closeModelPicker(clickEvent) {
  if (modelPicker && clickEvent && modelPicker.contains(clickEvent.target)) return;
  modelPicker?.remove();
  modelPicker = null;
  if (modelPickerCloser) document.removeEventListener("click", modelPickerCloser);
  modelPickerCloser = null;
}

async function toggleModelPicker(editEntry = null) {
  if (modelPicker && !editEntry) {
    closeModelPicker();
    return;
  }

  let data;
  try {
    const res = await hw("/api/models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    toast(`获取模型列表失败：${err.message}`);
    return;
  }

  const panel = el("div", "model-picker");
  panel.append(el("div", "model-picker-title", "选择模型"));
  const FORMAT_LABELS = { "chat-completions": "Chat", "anthropic-messages": "Anthropic", "responses": "Responses" };
  for (const m of data.models ?? []) {
    const item = el("div", `model-item${m.model === data.current ? " current" : ""}`);
    const main = el("button", "model-item-main");
    main.type = "button";
    main.append(el("span", "model-name", m.model));
    const metaParts = [m.provider, m.custom ? `线上 · ${FORMAT_LABELS[m.apiFormat] ?? "Chat"}` : m.declared ? "" : "自动发现"].filter(Boolean);
    main.append(el("span", "model-meta", metaParts.join(" · ")));
    if (m.model === data.current) main.disabled = true;
    main.addEventListener("click", () => void switchModel(m.model));
    item.append(main);
    if (m.custom) {
      const edit = el("button", "model-item-del", "✎");
      edit.type = "button";
      edit.title = `编辑线上模型 ${m.model}（URL / Key / API 格式 / 模型 ID / 上下文）`;
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        closeModelPicker();
        void toggleModelPicker({ ...m, isEdit: true });
      });
      item.append(edit);
      const del = el("button", "model-item-del", "✕");
      del.type = "button";
      del.title = `删除线上模型 ${m.model}（provider: ${m.provider}）`;
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void removeCustomModel(m.provider);
      });
      item.append(del);
    }
    panel.append(item);
  }
  panel.append(buildCustomModelForm(editEntry));

  document.body.append(panel);
  const rect = dom.modelChip.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  modelPicker = panel;
  modelPickerCloser = closeModelPicker;
  setTimeout(() => document.addEventListener("click", modelPickerCloser), 0);
}

async function switchModel(name) {
  closeModelPicker();
  toast(`切换模型到 ${name} …`);
  try {
    const res = await hw("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    toast(`✓ 已切换到 ${body.model}（对话已保留）`);
    // The server pushes a fresh state snapshot over SSE — the chip updates itself.
  } catch (err) {
    toast(`切换失败：${err.message}`);
  }
}

/** Toggle the「添加线上模型」form inside the picker; submit registers + persists it.
 *  editEntry (custom list item + isEdit) switches the form into edit mode, prefilled
 *  from the picker payload (apiKey stays blank — the server keeps the stored key). */
function buildCustomModelForm(editEntry = null) {
  const isEdit = editEntry?.isEdit === true;
  const wrap = el("div", "mp-custom");
  const addBtn = el("button", "mp-custom-toggle", isEdit ? `✎ 编辑「${editEntry.provider}」` : "➕ 添加线上模型");
  addBtn.type = "button";
  addBtn.title = isEdit
    ? `正在编辑线上模型 ${editEntry.provider}（API Key 留空则保持不变）`
    : "添加线上模型（自定义 URL / API Key / API 格式 / 模型 ID / 上下文长度）";
  const form = el("div", "mp-custom-form");
  // 新增默认折叠（点标题展开）；编辑模式保持展开，方便直接改字段。
  form.hidden = !isEdit;
  const toggleIcon = () => (form.hidden ? "▸" : "▾");

  const field = (labelText, placeholder, opts = {}) => {
    const label = el("label", "mp-field");
    label.append(el("span", "mp-field-label", labelText + (opts.optional ? "（可选）" : "")));
    const input = el("input", "mp-input");
    input.type = opts.secret ? "password" : "text";
    input.placeholder = placeholder;
    if (opts.value) input.value = opts.value;
    label.append(input);
    return { label, input };
  };

  const e = editEntry ?? {};
  const name = field("名称", "如 deepseek（留空则用模型 ID）", { optional: true, value: isEdit ? e.provider : "" });
  const url = field("Base URL", "https://api.deepseek.com（或含 /v1）", { value: isEdit ? e.baseUrl : "" });
  const key = field("API Key", isEdit ? "留空保持原 Key 不变" : "sk-…（本地代理可留空）", { optional: true, secret: true });
  const model = field("模型 ID", "如 deepseek-chat", { value: isEdit ? e.model : "" });
  const ctx = field("上下文长度", "tokens，如 65536（留空默认 32768）", { optional: true, value: isEdit && e.contextWindow ? String(e.contextWindow) : "" });

  // API wire format: three protocols, same OpenAI-compatible base URL field.
  const fmtLabel = el("label", "mp-field");
  fmtLabel.append(el("span", "mp-field-label", "API 格式"));
  const fmtSel = el("select", "mp-input mp-select");
  const fmtOptions = [
    ["chat-completions", "Chat Completions（/chat/completions）"],
    ["anthropic-messages", "Anthropic Messages（/v1/messages）"],
    ["responses", "Responses（/responses）"],
  ];
  for (const [value, text] of fmtOptions) {
    const opt = el("option");
    opt.value = value;
    opt.textContent = text;
    fmtSel.append(opt);
  }
  if (isEdit && e.apiFormat) fmtSel.value = e.apiFormat;
  fmtLabel.append(fmtSel);
  form.append(name.label, url.label, key.label, model.label, fmtLabel, ctx.label);

  const errLine = el("div", "mp-error");
  const submit = el("button", "mp-submit", isEdit ? "保存修改" : "保存并加入列表");
  submit.type = "button";
  submit.addEventListener("click", async () => {
    errLine.textContent = "";
    submit.disabled = true;
    submit.textContent = isEdit ? "保存中…" : "保存中…";
    try {
      const payload = {
        name: name.input.value.trim(),
        url: url.input.value.trim(),
        apiKey: key.input.value.trim(),
        model: model.input.value.trim(),
        context: Number(ctx.input.value) || undefined,
        apiFormat: fmtSel.value,
      };
      const endpoint = isEdit ? "/api/models/custom/update" : "/api/models/custom";
      if (isEdit) payload.provider = e.provider;
      const res = await hw(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      toast(isEdit ? `✓ 已修改 ${body.model}（provider: ${body.provider}）` : `✓ 已添加 ${body.model}，点击列表即可切换`);
      // Re-open the picker so the fresh list is visible.
      closeModelPicker();
      void toggleModelPicker();
    } catch (err) {
      errLine.textContent = err.message;
    } finally {
      submit.disabled = false;
      submit.textContent = isEdit ? "保存修改" : "保存并加入列表";
    }
  });
  form.append(errLine, submit);

  addBtn.addEventListener("click", () => {
    form.hidden = !form.hidden;
    addBtn.textContent = `${toggleIcon()} ${form.hidden ? (isEdit ? `编辑「${e.provider}」` : "添加线上模型") : "收起表单"}`;
    if (!form.hidden) (isEdit ? name : url).input.focus();
  });
  // sync the initial toggle icon now that form.hidden is settled
  addBtn.textContent = `${toggleIcon()} ${form.hidden ? (isEdit ? `编辑「${e.provider}」` : "添加线上模型") : "收起表单"}`;

  wrap.append(addBtn, form);
  return wrap;
}

/** Delete a custom online model by provider label, then refresh the open picker. */
async function removeCustomModel(provider) {
  if (!confirm(`删除线上模型「${provider}」？\n\n仅移除本工具中的接入配置，不影响服务商账号。`)) return;
  try {
    const res = await hw("/api/models/custom/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    toast(`✓ 已删除 ${provider}`);
    closeModelPicker();
    void toggleModelPicker();
  } catch (err) {
    toast(`删除失败：${err.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// knowledge base manager page (§5.2): status · ingest · search test · paged source admin
// ---------------------------------------------------------------------------------------------

let kbPage = null;
/** KB sources selected for batch ops (persists across pages and refreshes). */
const kbSelected = new Set();
/** Admin list filter/pagination state. view: "list" = paged table, "tree" = path hierarchy. */
const kbFilter = { page: 1, pageSize: 20, q: "", type: "all", view: "list" };
/** Directories the user expanded in tree view (keyed by full dir path). */
const kbTreeExpanded = new Set();
/** Whether the first tree render has auto-expanded the top-level directories. */
let kbTreeAutoExpanded = false;
/** Last fetched source list for the tree view; expand/collapse re-renders from it locally. */
let kbTreeList = [];
/** DOM refs of the open manager page (null when closed). */
let kbRefs = null;

function closeKbPage() {
  kbPage?.remove();
  kbPage = null;
  kbRefs = null;
  kbTreeExpanded.clear();
  kbTreeAutoExpanded = false;
}

function toggleKbPanel() {
  if (kbPage) {
    closeKbPage();
    return;
  }

  const overlay = el("div", "kbm-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeKbPage();
  });
  const page = el("div", "kbm-page");

  // -- header ---------------------------------------------------------------
  const header = el("div", "kbm-header");
  header.append(el("div", "kbm-title", "📚 知识库管理"));
  const closeBtn = el("button", "kbm-close", "✕");
  closeBtn.title = "关闭（Esc）";
  closeBtn.addEventListener("click", closeKbPage);
  header.append(closeBtn);

  const status = el("div", "kb-status", "加载中…");

  // -- ingest (with pre-import clean/chunk options) --------------------------
  const ingestRow = el("div", "kb-row");
  const pathInput = el("input", "kb-input");
  pathInput.type = "text";
  pathInput.placeholder = "导入本地文件或目录路径，逗号分隔（支持 md/txt/pdf/word/视频/音频）";
  const ingestBtn = el("button", "kb-btn-primary", "导入");
  ingestBtn.type = "button";
  const optToggle = el("button", "kb-src-btn", "⚙ 清洗/切片");
  optToggle.type = "button";
  optToggle.title = "展开导入前的数据清洗与切片设置";
  const pickBtn = el("button", "kb-src-btn", "📂 选路径");
  pickBtn.type = "button";
  pickBtn.title = "浏览服务器目录，点选文件/目录填入导入框";
  pickBtn.addEventListener("click", () => openFsPicker(pathInput));
  const ingestReport = el("div", "kb-report");
  ingestRow.append(pathInput, ingestBtn, optToggle, pickBtn);

  // -- clean/chunk option panel ----------------------------------------------
  const optPanel = el("div", "kbm-opt-panel");
  optPanel.hidden = true;
  optToggle.addEventListener("click", () => {
    optPanel.hidden = !optPanel.hidden;
  });

  const cleanDefs = [
    ["collapseWhitespace", "折叠空白与多余空行"],
    ["stripHtml", "去除 HTML 标签"],
    ["stripCodeFences", "去除代码块"],
    ["stripUrls", "去除链接 URL（保留文字）"],
    ["dropDuplicateLines", "去重复行/页眉页脚"],
  ];
  const cleanChecks = {};
  for (const [key, label] of cleanDefs) {
    const labelEl = el("label", "kbm-opt-check");
    const cb = el("input");
    cb.type = "checkbox";
    labelEl.append(cb, el("span", null, label));
    cleanChecks[key] = cb;
    optPanel.append(labelEl);
  }

  const chunkRow = el("div", "kbm-opt-chunkrow");
  const maxInput = el("input", "kb-input kbm-opt-num");
  maxInput.type = "number";
  maxInput.min = "200";
  maxInput.max = "16000";
  maxInput.step = "100";
  maxInput.value = "2048";
  maxInput.title = "每块最大字符数（200–16000，≈512 token 为 2048）";
  const overlapInput = el("input", "kb-input kbm-opt-num");
  overlapInput.type = "number";
  overlapInput.min = "0";
  overlapInput.placeholder = "自动 10%";
  overlapInput.title = "相邻块重叠字符数，留空 = 自动（切片大小的 10%）";
  chunkRow.append(
    el("span", "kbm-opt-label", "切片大小"),
    maxInput,
    el("span", "kbm-opt-unit", "字符"),
    el("span", "kbm-opt-label", "重叠"),
    overlapInput,
    el("span", "kbm-opt-unit", "字符"),
  );
  optPanel.append(chunkRow);

  const previewBtn = el("button", "kb-src-btn", "👁 预览切片");
  previewBtn.type = "button";
  previewBtn.title = "对导入框中的第一个文件做清洗+切片演练，不写库";
  optPanel.append(previewBtn);

  /** Read the panel into the API payload shape; empty selections are omitted. */
  const collectIngestOptions = () => {
    const clean = {};
    for (const [key, cb] of Object.entries(cleanChecks)) if (cb.checked) clean[key] = true;
    const chunk = {};
    if (Number(maxInput.value) > 0) chunk.maxChars = Number(maxInput.value);
    if (overlapInput.value !== "" && Number(overlapInput.value) >= 0) chunk.overlapChars = Number(overlapInput.value);
    return {
      ...(Object.keys(clean).length ? { clean } : {}),
      ...(Object.keys(chunk).length ? { chunk } : {}),
    };
  };

  ingestBtn.addEventListener("click", async () => {
    const paths = pathInput.value.split(",").map((p) => p.trim()).filter(Boolean);
    if (!paths.length) {
      ingestReport.textContent = "请输入至少一个路径";
      return;
    }
    ingestBtn.disabled = true;
    ingestBtn.textContent = "导入中…";
    ingestReport.textContent = "任务已提交…";
    try {
      const res = await hw("/api/kb/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths, ...collectIngestOptions() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      await pollIngestJob(body.jobId, ingestReport);
    } catch (err) {
      ingestReport.textContent = `导入失败：${err.message}`;
    } finally {
      ingestBtn.disabled = false;
      ingestBtn.textContent = "导入";
    }
  });

  previewBtn.addEventListener("click", async () => {
    const path = pathInput.value.split(",")[0].trim();
    if (!path) {
      ingestReport.textContent = "请先在导入框填写要预览的文件路径";
      return;
    }
    previewBtn.disabled = true;
    ingestReport.textContent = "预览中…";
    try {
      const res = await hw("/api/kb/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, ...collectIngestOptions() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      ingestReport.replaceChildren(...renderKbPreview(body));
    } catch (err) {
      ingestReport.textContent = `预览失败：${err.message}`;
    } finally {
      previewBtn.disabled = false;
    }
  });

  // -- search test ----------------------------------------------------------
  const searchRow = el("div", "kb-row");
  const queryInput = el("input", "kb-input");
  queryInput.type = "text";
  queryInput.placeholder = "检索测试：输入问题或关键词";
  const searchBtn = el("button", "kb-btn-primary", "检索");
  searchBtn.type = "button";
  const searchOut = el("div", "kb-search-out");
  searchRow.append(queryInput, searchBtn);

  const runSearch = async () => {
    const query = queryInput.value.trim();
    if (!query) return;
    searchBtn.disabled = true;
    searchOut.textContent = "检索中…";
    try {
      const res = await hw("/api/kb/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      searchOut.replaceChildren(...renderSearchHits(body));
    } catch (err) {
      searchOut.textContent = `检索失败：${err.message}`;
    } finally {
      searchBtn.disabled = false;
    }
  };
  searchBtn.addEventListener("click", () => void runSearch());
  queryInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) void runSearch();
  });

  // -- source admin: toolbar / batch bar / table / pager ---------------------
  const srcTitle = el("div", "kb-subtitle", "来源管理");

  const toolbar = el("div", "kbm-toolbar");
  const qInput = el("input", "kb-input kbm-q");
  qInput.type = "text";
  qInput.placeholder = "🔍 按路径搜索…";
  qInput.value = kbFilter.q;
  const typeSel = el("select", "kb-input kbm-type");
  for (const [value, label] of [
    ["all", "全部类型"],
    ["document", "文档"],
    ["video", "视频"],
    ["audio", "音频"],
    ["image", "图片"],
  ]) {
    const opt = el("option", null, label);
    opt.value = value;
    typeSel.append(opt);
  }
  typeSel.value = kbFilter.type;
  const sizeSel = el("select", "kb-input kbm-size");
  for (const size of [10, 20, 50]) {
    const opt = el("option", null, `${size} 条/页`);
    opt.value = String(size);
    sizeSel.append(opt);
  }
  sizeSel.value = String(kbFilter.pageSize);
  const viewToggle = el("div", "kbm-viewtoggle");
  const listBtn = el("button", "kbm-viewbtn", "列表");
  const treeBtn = el("button", "kbm-viewbtn", "🌲 树形");
  listBtn.type = "button";
  treeBtn.type = "button";
  treeBtn.title = "按目录层级展示来源";
  const syncViewButtons = () => {
    listBtn.classList.toggle("active", kbFilter.view === "list");
    treeBtn.classList.toggle("active", kbFilter.view === "tree");
  };
  listBtn.addEventListener("click", () => {
    if (kbFilter.view === "list") return;
    kbFilter.view = "list";
    kbFilter.page = 1;
    syncViewButtons();
    void refreshKbPage();
  });
  treeBtn.addEventListener("click", () => {
    if (kbFilter.view === "tree") return;
    kbFilter.view = "tree";
    kbFilter.page = 1;
    syncViewButtons();
    void refreshKbPage();
  });
  syncViewButtons();
  viewToggle.append(listBtn, treeBtn);
  toolbar.append(qInput, typeSel, sizeSel, viewToggle);

  const batchBar = el("div", "kbm-batch");
  const selInfo = el("span", "kbm-selinfo", "未选择");
  const rebuildSelBtn = el("button", "kb-src-btn", "⟳ 重建所选");
  rebuildSelBtn.title = "批量强制重建所选来源（单个后台任务）";
  const delSelBtn = el("button", "kb-src-btn danger", "🗑 删除所选");
  delSelBtn.title = "批量移除所选来源";
  batchBar.append(selInfo, rebuildSelBtn, delSelBtn);

  const table = el("div", "kbm-table", "加载中…");
  const pager = el("div", "kbm-pager");

  page.append(header, status, ingestRow, optPanel, ingestReport, searchRow, searchOut, srcTitle, toolbar, batchBar, table, pager);
  overlay.append(page);
  document.body.append(overlay);
  kbPage = overlay;
  kbRefs = { status, table, pager, selInfo, rebuildSelBtn, delSelBtn };

  let qTimer = null;
  qInput.addEventListener("input", () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      kbFilter.q = qInput.value.trim();
      kbFilter.page = 1;
      void refreshKbPage();
    }, 300);
  });
  typeSel.addEventListener("change", () => {
    kbFilter.type = typeSel.value;
    kbFilter.page = 1;
    void refreshKbPage();
  });
  sizeSel.addEventListener("change", () => {
    kbFilter.pageSize = Number(sizeSel.value) || 20;
    kbFilter.page = 1;
    void refreshKbPage();
  });
  delSelBtn.addEventListener("click", () => void removeSelectedSources(delSelBtn));
  rebuildSelBtn.addEventListener("click", () => void rebuildSelectedSources(rebuildSelBtn));
  document.addEventListener("keydown", kbEscCloser);

  void refreshKbPage();
}

function kbEscCloser(e) {
  if (e.key !== "Escape") return;
  if (document.querySelector(".fsp-overlay")) return; // path picker / preview handle their own Esc
  if (kbPage) closeKbPage();
}

function closeKbPageAndCleanListener() {
  document.removeEventListener("keydown", kbEscCloser);
  closeKbPage();
}

function updateKbBatchUI() {
  if (!kbRefs) return;
  const n = kbSelected.size;
  kbRefs.selInfo.textContent = n ? `已选 ${n} 项` : "未选择";
  kbRefs.delSelBtn.disabled = n === 0;
  kbRefs.delSelBtn.textContent = n ? `🗑 删除所选（${n}）` : "🗑 删除所选";
  kbRefs.rebuildSelBtn.disabled = n === 0;
}

/** Force re-index one path (background job); shared by list and tree views. */
async function kbRebuildSource(path, btn) {
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await hw("/api/kb/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path], force: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    toast(`⟳ 重建任务已提交：${path.split("/").pop()}`);
    await pollIngestJob(body.jobId, null);
  } catch (err) {
    toast(`重建失败：${err.message}`);
  }
  await refreshKbPage();
}

/** Remove one source from the index; shared by list and tree views. */
async function kbRemoveSource(path) {
  const name = path.split("/").pop();
  if (!confirm(`从知识库移除「${name}」？\n\n${path}\n\n全文索引与向量都会删除；磁盘上的原文件不受影响。`)) return;
  try {
    const res = await hw("/api/kb/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    kbSelected.delete(path);
    toast(body.warning ? `已移除（⚠ ${body.warning}）` : body.vectorsDropped ? "✓ 已移除（含向量）" : "✓ 已移除");
  } catch (err) {
    toast(`移除失败：${err.message}`);
  }
  await refreshKbPage();
}

async function refreshKbPage() {
  if (!kbPage || !kbRefs) return;
  const { status, table, pager } = kbRefs;
  try {
    const [statusRes, sourcesRes] = await Promise.all([
      hw("/api/kb/status"),
      fetch(
        `/api/kb/sources?${kbFilter.view === "tree" ? "all=1" : `page=${kbFilter.page}&pageSize=${kbFilter.pageSize}`}` +
          `&q=${encodeURIComponent(kbFilter.q)}&type=${kbFilter.type}`,
      ),
    ]);
    const s = await statusRes.json();
    if (!statusRes.ok) throw new Error(s?.error?.message ?? `HTTP ${statusRes.status}`);
    status.replaceChildren(
      el("span", "kb-dot ok"),
      el("span", null, `SQLite ${s.chunks} 块 / ${s.sources} 个来源 · `),
      el("span", null, `Qdrant ${s.vector.ok ? "✓ " + s.vector.collection : "✗ 离线（降级关键词检索）"} · `),
      el("span", null, `embed ${s.embedModel}`),
    );
    dom.kbCount.hidden = s.sources === 0;
    dom.kbCount.textContent = String(s.sources);

    const d = await sourcesRes.json();
    const pageData = d.sources ?? {};
    const list = pageData.sources ?? [];

    // -- tree view: build the path hierarchy client-side, no pagination --------
    if (kbFilter.view === "tree") {
      table.classList.add("kbm-tree");
      if (!kbTreeAutoExpanded) {
        const root = buildKbTree(list);
        for (const dir of root.dirs.values()) kbTreeExpanded.add(dir.path);
        kbTreeAutoExpanded = true;
      }
      kbTreeList = list;
      rerenderKbTree();
      pager.replaceChildren(
        el("span", "kbm-pageinfo", `🌲 树形视图 · 共 ${pageData.total ?? list.length} 个来源`),
      );
      updateKbBatchUI();
      return;
    }
    table.classList.remove("kbm-tree");

    // Server clamps out-of-range pages — mirror it back so the pager stays honest.
    kbFilter.page = pageData.page ?? kbFilter.page;

    const allChecked = list.length > 0 && list.every((src) => kbSelected.has(src.path));
    const headRow = el("div", "kbm-row kbm-head");
    const selectAll = el("input", "kb-src-check");
    selectAll.type = "checkbox";
    selectAll.checked = allChecked;
    selectAll.title = "全选/取消本页";
    selectAll.addEventListener("change", () => {
      for (const src of list) {
        if (selectAll.checked) kbSelected.add(src.path);
        else kbSelected.delete(src.path);
      }
      void refreshKbPage();
    });
    headRow.append(
      selectAll,
      el("span", "kbm-col-path", "路径"),
      el("span", "kbm-col-type", "类型"),
      el("span", "kbm-col-chunks", "块数"),
      el("span", "kbm-col-mtime", "修改时间"),
      el("span", "kbm-col-actions", "操作"),
    );

    table.replaceChildren(
      ...(list.length
        ? [
            headRow,
            ...list.map((src) => {
              const row = el("div", "kbm-row");
              const checkbox = el("input", "kb-src-check");
              checkbox.type = "checkbox";
              checkbox.checked = kbSelected.has(src.path);
              checkbox.addEventListener("change", () => {
                if (checkbox.checked) kbSelected.add(src.path);
                else kbSelected.delete(src.path);
                updateKbBatchUI();
              });
              const pathCell = el("span", "kbm-col-path kbm-path", src.path);
              pathCell.title = src.path;
              if (!MEDIA_TYPES.has(src.type)) {
                pathCell.classList.add("fsp-clickable");
                pathCell.addEventListener("click", () => void openKbFilePreview(src));
              }
              const typeBadge = el("span", "kbm-type-badge", src.type);
              const mtime = new Date(src.mtime);
              row.append(
                checkbox,
                pathCell,
                typeBadge,
                el("span", "kbm-col-chunks", String(src.chunkCount)),
                el(
                  "span",
                  "kbm-col-mtime",
                  `${mtime.getMonth() + 1}-${String(mtime.getDate()).padStart(2, "0")} ${timeLabel(src.mtime)}`,
                ),
              );
              const actions = el("span", "kbm-col-actions kbm-actions");
              if (!MEDIA_TYPES.has(src.type)) {
                const previewBtn = el("button", "kb-src-btn", "👁");
                previewBtn.title = "预览文件内容";
                previewBtn.addEventListener("click", () => void openKbFilePreview(src));
                actions.append(previewBtn);
              }
              const dl = el("a", "kb-src-btn", "⬇");
              dl.href = `${API_BASE}/api/fs/download?path=${encodeURIComponent(src.path)}`;
              dl.title = "下载原文件";
              const rebuildBtn = el("button", "kb-src-btn", "⟳");
              rebuildBtn.title = "重建：强制重新索引该路径（拾取文件内容改动）";
              const delBtn = el("button", "kb-src-btn danger", "🗑");
              delBtn.title = "从知识库移除该来源";
              rebuildBtn.addEventListener("click", () => void kbRebuildSource(src.path, rebuildBtn));
              delBtn.addEventListener("click", () => void kbRemoveSource(src.path));
              actions.append(dl, rebuildBtn, delBtn);
              row.append(actions);
              return row;
            }),
          ]
        : [el("div", "kb-empty", kbFilter.q || kbFilter.type !== "all" ? "没有匹配的来源。" : "尚未导入。输入本地路径开始导入资料。")]),
    );

    const prev = el("button", "kb-src-btn", "‹ 上一页");
    prev.disabled = (pageData.page ?? 1) <= 1;
    prev.addEventListener("click", () => {
      kbFilter.page = Math.max(1, kbFilter.page - 1);
      void refreshKbPage();
    });
    const next = el("button", "kb-src-btn", "下一页 ›");
    next.disabled = (pageData.page ?? 1) >= (pageData.totalPages ?? 1);
    next.addEventListener("click", () => {
      kbFilter.page = kbFilter.page + 1;
      void refreshKbPage();
    });
    pager.replaceChildren(
      prev,
      el(
        "span",
        "kbm-pageinfo",
        `第 ${pageData.page ?? 1}/${pageData.totalPages ?? 1} 页 · 共 ${pageData.total ?? 0} 条来源`,
      ),
      next,
    );
    updateKbBatchUI();
  } catch (err) {
    status.replaceChildren(el("span", "kb-dot err"), el("span", null, `知识库不可用：${err.message}`));
  }
}

// ---- KB tree view (path hierarchy) -----------------------------------------

/**
 * Re-render the tree from the cached kbTreeList — no server round trip. replaceChildren
 * briefly empties the table, so the .kbm-page scroll container's content collapses and its
 * scrollTop clamps to 0 ("jumps to the top"); save/restore around the swap prevents that,
 * and the toggled chevron gets focus back so keyboard flow survives the re-render.
 */
function rerenderKbTree(focusDirPath) {
  if (!kbRefs) return;
  const scroller = kbRefs.table.closest(".kbm-page");
  const top = scroller?.scrollTop ?? 0;
  kbRefs.table.replaceChildren(
    ...(kbTreeList.length
      ? renderKbTreeRows(buildKbTree(kbTreeList), 0, [])
      : [el("div", "kb-empty", kbFilter.q || kbFilter.type !== "all" ? "没有匹配的来源。" : "尚未导入。输入本地路径开始导入资料。")]),
  );
  if (scroller) scroller.scrollTop = top;
  if (focusDirPath) {
    kbRefs.table.querySelector(`.kbm-tree-chevron[data-dir="${CSS.escape(focusDirPath)}"]`)?.focus();
  }
}

/** Build a {name, path, dirs:Map, files[]} hierarchy from flat source records. */
function buildKbTree(list) {
  const root = { name: "", path: "", dirs: new Map(), files: [] };
  for (const src of list) {
    const parts = src.path.split("/").filter((p) => p.length > 0);
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc += "/" + parts[i];
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { name: parts[i], path: acc, dirs: new Map(), files: [] };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push(src);
  }
  return root;
}

/** All source records under a tree node, depth-first. */
function collectTreeFiles(node, acc = []) {
  acc.push(...node.files);
  for (const dir of node.dirs.values()) collectTreeFiles(dir, acc);
  return acc;
}

/** Depth-first rows: dirs first (sorted), then files; expanded dirs recurse. */
function renderKbTreeRows(node, depth, out) {
  const dirs = [...node.dirs.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  for (const dir of dirs) {
    out.push(makeKbDirRow(dir, depth));
    if (kbTreeExpanded.has(dir.path)) renderKbTreeRows(dir, depth + 1, out);
  }
  for (const file of node.files) out.push(makeKbFileRow(file, depth));
  return out;
}

function makeKbDirRow(dir, depth) {
  const files = collectTreeFiles(dir);
  const expanded = kbTreeExpanded.has(dir.path);
  const chunks = files.reduce((sum, f) => sum + (f.chunkCount || 0), 0);
  const row = el("div", "kbm-row kbm-tree-row kbm-tree-dir");
  row.style.paddingLeft = `${10 + depth * 18}px`;
  const chevron = el("button", "kbm-tree-chevron", expanded ? "▾" : "▸");
  chevron.type = "button";
  chevron.title = expanded ? "折叠" : "展开";
  chevron.dataset.dir = dir.path;
  chevron.addEventListener("click", () => {
    // Pure client state: toggle + local re-render. Going through refreshKbPage() here
    // would re-fetch and swap the whole table, clamping the page scroll back to the top.
    if (kbTreeExpanded.has(dir.path)) kbTreeExpanded.delete(dir.path);
    else kbTreeExpanded.add(dir.path);
    rerenderKbTree(dir.path);
  });
  const checkbox = el("input", "kb-src-check");
  checkbox.type = "checkbox";
  const allOn = files.length > 0 && files.every((f) => kbSelected.has(f.path));
  checkbox.checked = allOn;
  checkbox.indeterminate = !allOn && files.some((f) => kbSelected.has(f.path));
  checkbox.title = `选中/取消该目录下全部 ${files.length} 个文件`;
  checkbox.addEventListener("change", () => {
    for (const f of files) {
      if (checkbox.checked) kbSelected.add(f.path);
      else kbSelected.delete(f.path);
    }
    updateKbBatchUI();
    rerenderKbTree(); // recompute indeterminate states up the hierarchy, keep scroll
  });
  row.append(
    chevron,
    checkbox,
    el("span", "kbm-tree-icon", "📁"),
    el("span", "kbm-tree-dirname", dir.name),
    el("span", "kbm-tree-count", `${files.length} 文件 · ${chunks} 块`),
  );
  return row;
}

function makeKbFileRow(src, depth) {
  const row = el("div", "kbm-row kbm-tree-row");
  row.style.paddingLeft = `${28 + depth * 18}px`;
  const checkbox = el("input", "kb-src-check");
  checkbox.type = "checkbox";
  checkbox.checked = kbSelected.has(src.path);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) kbSelected.add(src.path);
    else kbSelected.delete(src.path);
    updateKbBatchUI();
  });
  const name = el("span", "kbm-path kbm-tree-file", src.path.split("/").pop());
  name.title = src.path;
  // Non-media files open an in-page preview on click; media downloads directly.
  if (!MEDIA_TYPES.has(src.type)) {
    name.classList.add("fsp-clickable");
    name.addEventListener("click", () => void openKbFilePreview(src));
  }
  const rebuildBtn = el("button", "kb-src-btn", "⟳");
  rebuildBtn.title = "重建：强制重新索引该路径";
  rebuildBtn.addEventListener("click", () => void kbRebuildSource(src.path, rebuildBtn));
  const delBtn = el("button", "kb-src-btn danger", "🗑");
  delBtn.title = "从知识库移除该来源";
  delBtn.addEventListener("click", () => void kbRemoveSource(src.path));
  const actions = el("span", "kbm-actions kbm-tree-actions");
  if (!MEDIA_TYPES.has(src.type)) {
    const previewBtn = el("button", "kb-src-btn", "👁");
    previewBtn.title = "预览文件内容";
    previewBtn.addEventListener("click", () => void openKbFilePreview(src));
    actions.append(previewBtn);
  }
  const dl = el("a", "kb-src-btn", "⬇");
  dl.href = `${API_BASE}/api/fs/download?path=${encodeURIComponent(src.path)}`;
  dl.title = "下载原文件";
  actions.append(dl, rebuildBtn, delBtn);
  row.append(
    checkbox,
    el("span", "kbm-tree-icon", "📄"),
    name,
    el("span", "kbm-type-badge", src.type),
    el("span", "kbm-tree-count", `${src.chunkCount} 块`),
    actions,
  );
  return row;
}

/** Render a previewIngest() response as report lines. */
function renderKbPreview(p) {
  const out = [];
  const saved = p.originalChars - p.cleanedChars;
  out.push(
    el(
      "div",
      "kb-report-line ok",
      `👁 ${p.file.split("/").pop()} · ${p.type} · 原文 ${p.originalChars} 字符 → 处理后 ${p.cleanedChars} 字符` +
        (saved > 0 ? `（清洗移除 ${saved}）` : ""),
    ),
  );
  out.push(el("div", "kb-report-line", `共 ${p.chunkCount} 块 · 每块 ≤ ${p.maxChars} 字符 · 相邻重叠 ${p.overlapChars} 字符`));
  for (const c of p.chunks) {
    out.push(
      el(
        "div",
        "kb-report-line",
        `#${c.index}${c.heading ? " §" + c.heading : ""}（${c.chars} 字符）: ` + c.text.replace(/\s+/g, " ").slice(0, 100),
      ),
    );
  }
  if (p.chunkCount > p.chunks.length) {
    out.push(el("div", "kb-report-line", `… 其余 ${p.chunkCount - p.chunks.length} 块略`));
  }
  return out;
}

// ---- filesystem picker + file preview --------------------------------------

/** Source types without a text preview (they download directly instead). */
const MEDIA_TYPES = new Set(["video", "audio", "image"]);

/** Picker labels for file kinds the KB cannot ingest yet. */
const KIND_LABELS = { deferred: "暂不支持" };

/** Human-readable byte size. */
function byteLabel(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Directory picker for the import box: browse server-side paths, ➕ appends a
 * dir/file path to the import input. Sub-overlay — its own Esc/click-outside,
 * and the KB page's Esc handler ignores it.
 */
function openFsPicker(pathInput) {
  if (document.querySelector(".fsp-overlay")) return;
  let lastEntries = null;

  const overlay = el("div", "kbm-overlay fsp-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const page = el("div", "fsp-page");

  const header = el("div", "fsp-header");
  header.append(el("div", "kbm-title", "📂 选择导入路径"));
  const closeBtn = el("button", "kbm-close", "✕");
  closeBtn.title = "关闭（Esc）";
  closeBtn.addEventListener("click", close);
  header.append(closeBtn);

  const navRow = el("div", "fsp-nav");
  const upBtn = el("button", "kb-src-btn", "⬆ 上一级");
  const homeBtn = el("button", "kb-src-btn", "🏠 家目录");
  const pickHereBtn = el("button", "kb-src-btn", "➕ 当前目录");
  pickHereBtn.title = "把当前目录路径加入导入框";
  const pathLabel = el("span", "fsp-path");
  navRow.append(upBtn, homeBtn, pickHereBtn, pathLabel);

  const list = el("div", "fsp-list", "加载中…");
  const hint = el("div", "fsp-hint", "点击 📁 名称进入目录；点 ➕ 把目录/文件加入导入框（🚫 = 该类型暂不支持导入）");

  page.append(header, navRow, list, hint);
  overlay.append(page);
  document.body.append(overlay);

  const escHandler = (e) => {
    if (e.key === "Escape") {
      // A stacked preview modal (workspace manager) closes first; the panel stays open.
      if (document.querySelector(".fsp-stacked")) return;
      close();
    }
  };
  document.addEventListener("keydown", escHandler);

  function close() {
    document.removeEventListener("keydown", escHandler);
    overlay.remove();
  }

  function addToImport(path) {
    const existing = pathInput.value.split(",").map((p) => p.trim()).filter(Boolean);
    if (existing.includes(path)) {
      toast("该路径已在导入框中");
      return;
    }
    existing.push(path);
    pathInput.value = existing.join(", ");
    toast(`已加入：${path.split("/").pop() || path}`);
  }

  async function load(target) {
    list.textContent = "加载中…";
    try {
      const res = await hw(`/api/fs/list?path=${encodeURIComponent(target)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      lastEntries = body;
      render(body);
    } catch (err) {
      list.textContent = `加载失败：${err.message}`;
    }
  }

  function render(data) {
    pathLabel.textContent = data.path;
    pathLabel.title = data.path;
    upBtn.disabled = !data.parent;
    const rows = [];
    for (const entry of data.entries) {
      const row = el("div", "fsp-row");
      if (entry.isDir) {
        const name = el("button", "fsp-name fsp-dirname", `📁 ${entry.name}/`);
        name.title = "进入目录";
        name.addEventListener("click", () => void load(entry.path));
        const add = el("button", "kb-src-btn", "➕");
        add.title = "把该目录加入导入框";
        add.addEventListener("click", () => addToImport(entry.path));
        row.append(name, add);
      } else {
        const name = el("span", "fsp-name", `${entry.ingestable ? "📄" : "🚫"} ${entry.name}`);
        name.title = entry.ingestable ? entry.path : `${entry.path}（该类型暂不支持导入）`;
        if (!entry.ingestable) name.classList.add("fsp-disabled");
        const meta = el("span", "fsp-meta", entry.size ? byteLabel(entry.size) : "");
        row.append(name, meta);
        if (entry.ingestable) {
          const add = el("button", "kb-src-btn", "➕");
          add.title = "把该文件加入导入框";
          add.addEventListener("click", () => addToImport(entry.path));
          row.append(add);
        } else {
          row.append(el("span", "fsp-meta", KIND_LABELS[entry.kind] ?? entry.kind ?? "不支持"));
        }
      }
      rows.push(row);
    }
    list.replaceChildren(...(rows.length ? rows : [el("div", "fsp-hint", "（空目录）")]));
  }

  upBtn.addEventListener("click", () => {
    if (lastEntries?.parent) void load(lastEntries.parent);
  });
  homeBtn.addEventListener("click", () => void load("~"));
  pickHereBtn.addEventListener("click", () => void addToImport(lastEntries?.path ?? "~"));
  void load("~");
}

/**
 * Workspace file manager — tree view of the agent's working directory (files it produced).
 * Directories expand lazily (fetch /api/fs/list on first expand); files preview in a
 * stacked modal or download. Root is locked to the agent cwd from GET /api/workspace.
 */
async function openWorkspacePanel() {
  if (document.querySelector(".fsp-workspace")) return;

  let root = null;
  try {
    const res = await hw("/api/workspace");
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    root = body.cwd;
  } catch (err) {
    toast(`获取工作目录失败：${err.message}`);
    return;
  }
  const rootName = root.split("/").pop() || root;

  const overlay = el("div", "kbm-overlay fsp-overlay fsp-workspace");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const page = el("div", "fsp-page");

  const header = el("div", "fsp-header");
  header.append(el("div", "kbm-title", `📁 工作区 · ${rootName}`));
  const closeBtn = el("button", "kbm-close", "✕");
  closeBtn.title = "关闭（Esc）";
  closeBtn.addEventListener("click", close);
  header.append(closeBtn);

  const navRow = el("div", "fsp-nav");
  const expandAllBtn = el("button", "kb-src-btn", "⤢ 展开全部");
  const collapseAllBtn = el("button", "kb-src-btn", "⤡ 折叠全部");
  const refreshBtn = el("button", "kb-src-btn", "⟳ 刷新");
  const pathLabel = el("span", "fsp-path", root);
  pathLabel.title = root;
  navRow.append(expandAllBtn, collapseAllBtn, refreshBtn, pathLabel);

  const tree = el("div", "ws-tree", "加载中…");
  const hint = el("div", "fsp-hint", "智能体运行产物都在这里：点 ▸ 展开目录，点文件名预览，⬇ 下载原文件");

  page.append(header, navRow, tree, hint);
  overlay.append(page);
  document.body.append(overlay);

  const escHandler = (e) => {
    if (e.key === "Escape") {
      if (document.querySelector(".fsp-stacked")) return; // stacked preview closes first
      close();
    }
  };
  document.addEventListener("keydown", escHandler);

  function close() {
    document.removeEventListener("keydown", escHandler);
    overlay.remove();
  }

  /** Render a directory's entries into a container; dirs are lazy-expandable. */
  function renderEntries(entries, container) {
    const rows = [];
    for (const entry of entries) {
      if (entry.isDir) {
        const wrap = el("div", "ws-dir-wrap");
        const row = el("div", "fsp-row ws-dir");
        const chev = el("button", "ws-chevron", "▸");
        chev.title = "展开/折叠目录";
        const name = el("span", "fsp-name fsp-dirname", `📁 ${entry.name}/`);
        name.title = entry.path;
        row.append(chev, name, el("span", "fsp-meta", "目录"));
        const children = el("div", "ws-children");
        children.hidden = true;
        chev.addEventListener("click", async () => {
          if (children.hidden) {
            if (!children.dataset.loaded) {
              children.textContent = "加载中…";
              try {
                const res = await hw(`/api/fs/list?path=${encodeURIComponent(entry.path)}`);
                const body = await res.json();
                if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
                children.replaceChildren();
                renderEntries(body.entries, children);
                children.dataset.loaded = "1";
              } catch (err) {
                children.textContent = `加载失败：${err.message}`;
              }
            }
            children.hidden = false;
            chev.textContent = "▾";
          } else {
            children.hidden = true;
            chev.textContent = "▸";
          }
        });
        wrap.append(row, children);
        rows.push(wrap);
      } else {
        const row = el("div", "fsp-row ws-file");
        const name = el("button", "fsp-name", `📄 ${entry.name}`);
        name.title = `${entry.path}（点击预览）`;
        name.addEventListener("click", () => {
          void openKbFilePreview({ path: entry.path, type: entry.kind ?? "" }, { stacked: true });
        });
        const meta = el("span", "fsp-meta", `${byteLabel(entry.size || 0)}`);
        meta.title = new Date(entry.mtime || Date.now()).toLocaleString();
        const dl = el("a", "kb-src-btn", "⬇");
        dl.href = `${API_BASE}/api/fs/download?path=${encodeURIComponent(entry.path)}`;
        dl.title = "下载文件";
        row.append(el("span", "ws-chevron-placeholder"), name, meta, dl);
        rows.push(row);
      }
    }
    container.replaceChildren(...(rows.length ? rows : [el("div", "fsp-hint", "（空目录）")]));
  }

  /** Recursively expand every loaded dir (and lazy-load one level). */
  async function expandAll() {
    const expanders = [...tree.querySelectorAll(".ws-chevron")];
    for (const chev of expanders) {
      if (chev.textContent === "▸") {
        chev.click();
        // give lazy children a tick to render so nested chevrons queue up
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    // go deeper: re-scan after newly lazy-loaded dirs revealed their own chevrons
    if (tree.querySelector('.ws-chevron:not([data-deep="1"])')) {
      // best-effort one extra level — avoid unbounded recursion on huge trees
      const next = [...tree.querySelectorAll(".ws-chevron")].filter((c) => c.textContent === "▸");
      for (const chev of next) chev.click();
    }
  }

  function collapseAll() {
    for (const chev of tree.querySelectorAll(".ws-chevron")) {
      if (chev.textContent === "▾") chev.click();
    }
  }

  expandAllBtn.addEventListener("click", () => void expandAll());
  collapseAllBtn.addEventListener("click", collapseAll);
  refreshBtn.addEventListener("click", async () => {
    tree.textContent = "加载中…";
    try {
      const res = await hw(`/api/fs/list?path=${encodeURIComponent(root)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      renderEntries(body.entries, tree);
    } catch (err) {
      tree.textContent = `加载失败：${err.message}`;
    }
  });

  // initial root load
  try {
    const res = await hw(`/api/fs/list?path=${encodeURIComponent(root)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    renderEntries(body.entries, tree);
  } catch (err) {
    tree.textContent = `加载失败：${err.message}`;
  }
}

// ---------------------------------------------------------------------------------------------
// data viewer (admin): SQLite kb.db inspector + Qdrant collection browser
// ---------------------------------------------------------------------------------------------

let dataPanel = null;
let dataPanelCloser = null;

function closeDataPanel(clickEvent) {
  if (dataPanel && clickEvent && dataPanel.contains(clickEvent.target)) return;
  dataPanel?.remove();
  dataPanel = null;
  if (dataPanelCloser) document.removeEventListener("click", dataPanelCloser);
  dataPanelCloser = null;
}

/** Render an array-of-arrays result as an HTML table with a header row. */
function renderSqlResult(columns, rows, truncated) {
  const wrap = el("div", "dv-result");
  if (!columns.length) {
    wrap.append(el("div", "fsp-hint", "（无结果）"));
    return wrap;
  }
  const table = el("table", "dv-table");
  const head = el("thead");
  const headRow = el("tr");
  for (const c of columns) headRow.append(el("th", null, c));
  head.append(headRow);
  const body = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const v of r) {
      const td = el("td");
      const text = v === null ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
      td.textContent = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      td.title = text;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  wrap.append(table);
  if (truncated) wrap.append(el("div", "kb-report-line warn", "⚠ 结果已截断（仅显示前 N 行）"));
  return wrap;
}

async function openDataPanel() {
  if (dataPanel) {
    closeDataPanel();
    return;
  }
  const overlay = el("div", "kbm-overlay fsp-overlay dv-overlay");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDataPanel();
  });
  const page = el("div", "fsp-page dv-page");
  const header = el("div", "fsp-header");
  header.append(el("div", "kbm-title", "🗄️ 数据查看"));
  const closeBtn = el("button", "kbm-close", "✕");
  closeBtn.title = "关闭（Esc）";
  closeBtn.addEventListener("click", () => closeDataPanel());
  header.append(closeBtn);

  const tabs = el("div", "dv-tabs");
  const tabSqlite = el("button", "dv-tab active", "SQLite · kb.db");
  const tabQdrant = el("button", "dv-tab", "Qdrant 向量库");
  tabs.append(tabSqlite, tabQdrant);

  const sqlitePane = el("div", "dv-pane");
  const qdrantPane = el("div", "dv-pane");
  qdrantPane.hidden = true;

  // --- SQLite pane ---
  const sqlLayout = el("div", "dv-layout");
  const sqlSidebar = el("div", "dv-sidebar");
  sqlSidebar.append(el("div", "fsp-hint", "表（点击加载前 100 行）"));
  const tableList = el("div", "dv-tablelist", "加载中…");
  sqlSidebar.append(tableList);
  const sqlMain = el("div", "dv-main");
  const sqlForm = el("div", "dv-sqlform");
  const sqlInput = el("textarea", "dv-sql");
  sqlInput.rows = 3;
  sqlInput.placeholder = "SELECT * FROM sources LIMIT 10  （只读，强制 LIMIT 保护）";
  const runBtn = el("button", "kb-src-btn", "▶ 执行");
  sqlForm.append(sqlInput, runBtn);
  const sqlResult = el("div", "dv-result-area");
  sqlResult.append(el("div", "fsp-hint", "在左侧选一张表，或输入 SQL 后点「执行」"));
  sqlMain.append(sqlForm, sqlResult);
  sqlLayout.append(sqlSidebar, sqlMain);
  sqlitePane.append(sqlLayout);

  async function loadTables() {
    tableList.textContent = "加载中…";
    try {
      const res = await hw("/api/db/tables");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      tableList.replaceChildren();
      const meta = el("div", "dv-dbpath", body.path);
      meta.title = body.path;
      tableList.append(meta);
      for (const t of body.tables) {
        const item = el("button", "dv-table-item");
        item.append(el("span", "dv-tname", t.name), el("span", "dv-tcount", t.count < 0 ? "—" : `${t.count} 行`));
        item.title = t.columns.join(", ");
        item.addEventListener("click", () => {
          sqlInput.value = `SELECT * FROM "${t.name}" LIMIT 100`;
          void runSql();
        });
        tableList.append(item);
      }
    } catch (err) {
      tableList.textContent = `加载失败：${err.message}`;
    }
  }

  async function runSql() {
    const sql = sqlInput.value.trim();
    if (!sql) return;
    sqlResult.textContent = "执行中…";
    runBtn.disabled = true;
    try {
      const res = await hw("/api/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, limit: 100 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      sqlResult.replaceChildren(renderSqlResult(body.columns, body.rows, body.truncated));
    } catch (err) {
      sqlResult.replaceChildren(el("div", "kb-empty", `查询失败：${err.message}`));
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener("click", () => void runSql());
  sqlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void runSql();
    }
  });

  // --- Qdrant pane ---
  qdrantPane.append(el("div", "fsp-hint", "Qdrant 向量库：集合列表 + 点浏览（离线时显示连接错误）"));
  const qdStatus = el("div", "dv-qdstatus", "检测中…");
  const qdCollections = el("div", "dv-tablelist");
  const qdPoints = el("div", "dv-result-area");
  qdPoints.append(el("div", "fsp-hint", "点左侧集合名浏览其中的向量点"));
  qdrantPane.append(qdStatus, qdCollections, qdPoints);

  async function loadQdrant() {
    qdStatus.textContent = "检测中…";
    qdCollections.textContent = "";
    try {
      const res = await hw("/api/qdrant/collections");
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      qdStatus.textContent = body.online ? "🟢 Qdrant 在线" : "🔴 Qdrant 离线（KB 向量检索不可用，但 kb.db 文本检索仍可用）";
      qdStatus.className = `dv-qdstatus ${body.online ? "online" : "offline"}`;
      const cols = body.collections ?? [];
      qdCollections.replaceChildren();
      if (!cols.length) {
        qdCollections.append(el("div", "fsp-hint", body.online ? "（无集合）" : `连接错误：${body.raw?.error ?? body.raw?.status ?? ""}`));
        return;
      }
      for (const c of cols) {
        const name = typeof c === "string" ? c : c?.name ?? JSON.stringify(c);
        const item = el("button", "dv-table-item");
        item.append(el("span", "dv-tname", name));
        item.addEventListener("click", () => void loadPoints(name));
        qdCollections.append(item);
      }
    } catch (err) {
      qdStatus.textContent = `加载失败：${err.message}`;
    }
  }

  async function loadPoints(collection) {
    qdPoints.textContent = "加载中…";
    try {
      const res = await hw(`/api/qdrant/collections/${encodeURIComponent(collection)}/points?limit=20`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      const points = body.points ?? [];
      if (!points.length) {
        qdPoints.replaceChildren(el("div", "fsp-hint", "（该集合无点）"));
        return;
      }
      qdPoints.replaceChildren();
      for (const p of points) {
        const card = el("div", "dv-point");
        const id = typeof p === "object" ? p?.id : p;
        const payload = (typeof p === "object" ? p?.payload : null) ?? {};
        card.append(el("div", "dv-point-id", `point · ${id}`));
        const body2 = el("pre", "fsp-text");
        body2.textContent = JSON.stringify(payload, null, 2).slice(0, 800);
        card.append(body2);
        qdPoints.append(card);
      }
      if (body.nextOffset) {
        const more = el("button", "kb-src-btn", "⬇ 加载更多");
        more.addEventListener("click", () => {
          void loadPoints(`${collection}__offset__${body.nextOffset}`);
        });
        qdPoints.append(more);
      }
    } catch (err) {
      qdPoints.replaceChildren(el("div", "kb-empty", `加载失败：${err.message}`));
    }
  }

  page.append(header, tabs, sqlitePane, qdrantPane);
  overlay.append(page);
  document.body.append(overlay);
  dataPanel = overlay;

  const escHandler = (e) => {
    if (e.key === "Escape") closeDataPanel();
  };
  document.addEventListener("keydown", escHandler);
  // closeDataPanel (module-level) removes the click listener; pair it with the Esc listener here.
  dataPanelCloser = (evt) => {
    if (dataPanel && evt && dataPanel.contains(evt.target)) return;
    closeDataPanel();
    document.removeEventListener("keydown", escHandler);
  };
  setTimeout(() => document.addEventListener("click", dataPanelCloser), 0);
  closeBtn.addEventListener("click", () => {
    closeDataPanel();
    document.removeEventListener("keydown", escHandler);
  });

  tabSqlite.addEventListener("click", () => {
    tabSqlite.classList.add("active");
    tabQdrant.classList.remove("active");
    sqlitePane.hidden = false;
    qdrantPane.hidden = true;
  });
  tabQdrant.addEventListener("click", () => {
    tabQdrant.classList.add("active");
    tabSqlite.classList.remove("active");
    qdrantPane.hidden = false;
    sqlitePane.hidden = true;
    if (!qdCollections.children.length) void loadQdrant();
  });

  void loadTables();
}

/**
 * Preview one file in a modal (GET /api/fs/read). Markdown renders as
 * rich text, others as plain preformatted text; media types download instead.
 * stacked=true (workspace manager) lets the modal open on top of the browse panel.
 */
async function openKbFilePreview(src, { stacked = false } = {}) {
  if (MEDIA_TYPES.has(src.type)) {
    window.open(`${API_BASE}/api/fs/download?path=${encodeURIComponent(src.path)}`, "_blank");
    return;
  }
  if (!stacked && document.querySelector(".fsp-overlay")) return;

  const overlay = el("div", `kbm-overlay fsp-overlay${stacked ? " fsp-stacked" : ""}`);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const page = el("div", "fsp-page fsp-preview");
  const header = el("div", "fsp-header");
  const title = el("div", "kbm-title", `📄 ${src.path.split("/").pop() || ""}`);
  title.title = src.path;
  const meta = el("span", "fsp-meta", src.type);
  const btns = el("div", "fsp-headerbtns");
  const dl = el("a", "kb-src-btn", "⬇ 下载");
  dl.href = `${API_BASE}/api/fs/download?path=${encodeURIComponent(src.path)}`;
  const closeBtn = el("button", "kbm-close", "✕");
  closeBtn.title = "关闭（Esc）";
  btns.append(dl, closeBtn);
  header.append(title, meta, btns);
  const body = el("div", "fsp-body", "加载中…");
  page.append(header, body);
  overlay.append(page);
  document.body.append(overlay);

  const escHandler = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", escHandler);
  closeBtn.addEventListener("click", close);

  function close() {
    document.removeEventListener("keydown", escHandler);
    overlay.remove();
  }

  try {
    const res = await hw(`/api/fs/read?path=${encodeURIComponent(src.path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
    meta.textContent = `${data.kind} · ${byteLabel(data.size)}`;
    if (data.kind === "markdown") {
      const rendered = el("div", "msg-content fsp-md");
      rendered.innerHTML = renderMarkdown(data.content);
      body.replaceChildren(rendered);
    } else {
      const pre = el("pre", "fsp-text");
      pre.textContent = data.content;
      body.replaceChildren(pre);
    }
    if (data.truncated) body.append(el("div", "kb-report-line warn", "⚠ 文件过大，仅显示前 512 KB"));
  } catch (err) {
    body.replaceChildren(
      el("div", "kb-empty", `无法预览：${err.message}\n（文件可能已从磁盘删除；可尝试下载，或先删除该来源再重新导入）`),
    );
  }
}

async function removeSelectedSources(btn) {
  const selected = [...kbSelected];
  if (!selected.length) return;
  const preview = selected.slice(0, 8).join("\n") + (selected.length > 8 ? `\n… 共 ${selected.length} 项` : "");
  if (!confirm(`批量移除 ${selected.length} 个来源？\n\n${preview}\n\n全文索引与向量都会删除；磁盘原文件不受影响。`)) return;
  btn.disabled = true;
  btn.textContent = "删除中…";
  let ok = 0;
  for (const path of selected) {
    try {
      const res = await hw("/api/kb/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (res.ok) ok++;
      else toast(`移除失败：${path.split("/").pop()}`);
    } catch {
      toast(`移除失败：${path.split("/").pop()}`);
    }
  }
  kbSelected.clear();
  toast(`✓ 已移除 ${ok}/${selected.length} 个来源`);
  await refreshKbPage();
}

async function rebuildSelectedSources(btn) {
  const selected = [...kbSelected];
  if (!selected.length) return;
  btn.disabled = true;
  try {
    const res = await hw("/api/kb/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: selected, force: true }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
    toast(`⟳ 重建任务已提交（${selected.length} 项）`);
    await pollIngestJob(body.jobId, null);
  } catch (err) {
    toast(`批量重建失败：${err.message}`);
  }
  await refreshKbPage();
}

/** Poll a background ingest job until it settles, then render the report.
 * `out` may be null (rebuild button case: progress stays silent, result toasts). */
async function pollIngestJob(jobId, out) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1200));
    let job;
    try {
      const res = await hw(`/api/kb/jobs/${jobId}`);
      if (!res.ok) {
        if (out) out.textContent = `任务状态查询失败（HTTP ${res.status}）`;
        return;
      }
      job = await res.json();
    } catch (err) {
      if (out) out.textContent = `任务状态查询失败：${err.message}`;
      return;
    }
    if (job.status === "running") {
      if (out) {
        const p = job.progress;
        out.textContent = p
          ? `导入中 ${p.index}/${p.total}：${p.file.split("/").pop()}（${p.kind === "media" ? "媒体管线，较慢" : "文档"}）…`
          : "导入中…";
      }
      continue;
    }
    if (job.status === "error") {
      if (out) out.textContent = `导入失败：${job.error}`;
      else toast(`重建失败：${job.error}`);
      return;
    }
    if (out) {
      out.replaceChildren(...renderIngestReport(job.report ?? { added: [], updated: [], skipped: [], failed: [], warnings: [], chunks: 0, vectors: 0, mode: "fts_only" }));
    } else {
      const report = job.report;
      const failed = report?.failed?.length ?? 0;
      toast(
        failed
          ? `重建失败：${report.failed[0].message}`
          : `✓ 已重建（切片 ${report?.chunks ?? 0} · 向量 ${report?.vectors ?? 0}）`,
      );
    }
    await refreshKbPage();
    return;
  }
}

function renderIngestReport(report) {
  const nodes = [];
  const okCount = report.added.length + report.updated.length;
  nodes.push(
    el(
      "div",
      `kb-report-line ${report.failed.length ? "warn" : "ok"}`,
      `✓ 新增 ${report.added.length} · 更新 ${report.updated.length} · 跳过 ${report.skipped.length} · ` +
        `切片 ${report.chunks} · 向量 ${report.vectors}（${report.mode === "hybrid" ? "hybrid" : "仅关键词"}）` +
        (okCount || report.failed.length ? "" : "（无变化）"),
    ),
  );
  for (const f of report.failed.slice(0, 5)) {
    nodes.push(el("div", "kb-report-line err", `✗ ${f.path}：${f.message}`));
  }
  for (const w of report.warnings.slice(0, 3)) {
    nodes.push(el("div", "kb-report-line warn", `⚠ ${w}`));
  }
  return nodes;
}

function renderSearchHits(result) {
  const nodes = [el("div", "kb-report-line", `检索模式：${result.mode === "hybrid" ? "hybrid（向量+关键词）" : "仅关键词（降级）"}`)];
  if (!result.hits?.length) {
    nodes.push(el("div", "kb-empty", "没有命中。先导入资料，或换个说法。"));
    return nodes;
  }
  for (const [i, hit] of result.hits.entries()) {
    const citation = hit.startMs !== undefined ? `${hit.source.split("/").pop()} @ ${Math.floor(hit.startMs / 60000)}:${String(Math.floor((hit.startMs % 60000) / 1000)).padStart(2, "0")}` : hit.source;
    const card = el("div", "kb-hit");
    card.append(
      el("div", "kb-hit-head", `${i + 1}. ${citation} · score ${hit.score.toFixed(3)}`),
      el("div", "kb-hit-text", hit.text.length > 240 ? `${hit.text.slice(0, 240)}…` : hit.text),
    );
    nodes.push(card);
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// skills panel (§10.1) — GET /api/skills; click a skill to preview its body
// ---------------------------------------------------------------------------------------------

let skillsPanel = null;
let skillsPanelCloser = null;

function closeSkillsPanel(clickEvent) {
  if (skillsPanel && clickEvent && skillsPanel.contains(clickEvent.target)) return;
  skillsPanel?.remove();
  skillsPanel = null;
  if (skillsPanelCloser) document.removeEventListener("click", skillsPanelCloser);
  skillsPanelCloser = null;
}

async function toggleSkillsPanel() {
  if (skillsPanel) {
    closeSkillsPanel();
    return;
  }

  const panel = el("div", "kb-panel");
  panel.append(el("div", "kb-title", "🧩 技能（斜杠命令 + 关键词自动触发）"));
  const list = el("div", "kb-sources", "加载中…");
  panel.append(list);

  document.body.append(panel);
  panel.style.top = "52px";
  panel.style.left = "208px";
  skillsPanel = panel;
  skillsPanelCloser = closeSkillsPanel;
  setTimeout(() => document.addEventListener("click", skillsPanelCloser), 0);

  try {
    const res = await hw("/api/skills");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const skills = (await res.json()).skills ?? [];
    skillsCache = skills;
    dom.skillsCount.hidden = skills.length === 0;
    dom.skillsCount.textContent = String(skills.length);

    if (!skills.length) {
      list.replaceChildren(
        el(
          "div",
          "kb-empty",
          "尚未安装技能。把技能目录放进 ~/.harness/skills/（SKILL.yaml + SKILL.md）或项目 .harness/skills/ 即可。",
        ),
      );
      return;
    }
    list.replaceChildren(
      ...skills.map((skill) => {
        const item = el("div", "skill-item");
        const head = el("div", "skill-head");
        head.append(
          el("span", "slash-cmd", skill.slash),
          el("span", "skill-src", skill.source === "project" ? "项目" : "用户"),
        );
        const desc = el("div", "skill-desc", skill.description || "（无描述）");
        const meta = el("div", "skill-meta");
        if (skill.keywords?.length) meta.append(el("span", "skill-kw", `触发词: ${skill.keywords.join(" / ")}`));
        if (skill.argumentHint) meta.append(el("span", "skill-kw", `参数: ${skill.argumentHint}`));
        if (skill.dir) meta.append(el("span", "skill-kw", `目录: ${skill.dir}`));
        const body = el("pre", "skill-body");
        body.hidden = true;
        body.textContent = skill.body || "（该技能没有 SKILL.md 正文）";
        head.addEventListener("click", () => {
          body.hidden = !body.hidden;
          item.classList.toggle("open");
        });
        item.append(head, desc, meta, body);
        return item;
      }),
    );
  } catch (err) {
    list.replaceChildren(el("div", "kb-empty", `技能列表加载失败：${err.message}`));
  }
}

async function bootstrap() {
  buildPhaseRows();
  bindEvents();
  renderComposer();

  // Rebuild the saved session list; each session's content comes from the SSE replay.
  const saved = loadPersistedSessions();
  if (saved) {
    for (const s of saved) createSession("", s);
    if (sessions.length) activateSession(sessions[sessions.length - 1]);
  } else {
    createSession("新任务");
  }
  dom.chat.replaceChildren(activeSession?.stream ?? el("div", "chat-stream"));

  // Seed the panel before SSE connects (the stream also sends a snapshot on open).
  try {
    const res = await hw("/api/state");
    if (res.ok) applyState(await res.json());
  } catch {
    /* SSE reconnect will retry */
  }

  connect();
}

void bootstrap();
