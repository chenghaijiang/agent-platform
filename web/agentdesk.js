/* ============================================================
   AgentDesk 工作台（T15 前端）
   纯静态 vanilla JS：登录复用知识问答域账号（zs_token/zs_user），
   数据源全部为真实 API（/api/agentdesk/*）：
   - SSE（GET + fetch/ReadableStream + Last-Event-ID，与 chat SSE 同机制）
     驱动 13 类事件渲染：打开任务 cursor=0 全量回放重建界面，
     断线重连带 Last-Event-ID 续传（零丢失）；
   - 计划确认 / 审批三选 / hunk 评审 / 门禁提交均调 T14 端点。
   交互与视觉对齐 web/agentdesk-demo.html（验收基准，Q3 决策）。
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const MODE_LABELS = {
  confirm: "变更前确认",
  auto_edit: "自动编辑",
  plan: "计划模式",
  full_access: "完全访问",
};
const MODE_ORDER = ["confirm", "auto_edit", "plan", "full_access"];
const STATUS_TEXT = {
  created: "排队中", planned: "计划待确认", running: "运行中", verifying: "检查中",
  blocked: "等待审批", review: "待验收", committed: "已提交", partial: "部分完成", cancelled: "已取消",
};
// 状态 → rail 圆点色（demo 四色语义：run 执行中 / ok 完成 / block 受阻 / idle 排队）
const STATUS_DOT = {
  created: "idle", planned: "run", running: "run", verifying: "run", blocked: "block",
  review: "run", committed: "ok", partial: "block", cancelled: "idle",
};
// 状态 → topbar pill 样式（demo pill 四色：run/review/ok/block）
const STATUS_PILL = {
  created: "run", planned: "review", running: "run", verifying: "run", blocked: "block",
  review: "review", committed: "ok", partial: "block", cancelled: "",
};

const state = {
  token: localStorage.getItem("zs_token") || "",
  user: JSON.parse(localStorage.getItem("zs_user") || "null"),
  tasks: [],
  activeTask: null,       // 当前任务详情（GET /tasks/{id} 响应）
  defaultMode: "confirm", // 新建任务默认模式（顶栏菜单）
  seq: 0,                 // SSE 已消费的最大 seq（Last-Event-ID 续传游标）
  seen: new Set(),        // 已渲染事件 seq（防重叠连接重复渲染）
  epoch: 0,               // 打开任务代数：旧连接回包/重连定时器失效判据
  done: false,            // 收到 done 帧（终态且事件耗尽，停止重连）
  abort: null,            // 当前 SSE 连接的 AbortController
  checks: [],             // check_result 聚合 [{command, ok, exit_code}]
  audit: { tools: 0, approvals: 0, blocked: 0, steps: 0 },
  listTimer: null,
};

/* ============================================================
   通用：toast / 转义 / API 客户端
   ============================================================ */
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

async function api(path, opts = {}) {
  const res = await fetch("/api/agentdesk" + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + state.token,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error("登录已失效，请重新登录");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* 保留 statusText */ }
    const err = new Error(`${res.status} ${detail}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* ============================================================
   登录 / 登出（与 app.js 同一 localStorage 契约）
   ============================================================ */
function logout() {
  state.token = "";
  state.user = null;
  localStorage.removeItem("zs_token");
  localStorage.removeItem("zs_user");
  clearInterval(state.listTimer);
  closeTaskStream();
  $("ad-app").hidden = true;
  $("ad-login").hidden = false;
}

function enterDesk() {
  $("ad-login").hidden = true;
  $("ad-app").hidden = false;
  const name = state.user.username;
  $("adUserName").textContent = name;
  $("adUserRole").textContent = state.user.role === "admin" ? "平台管理员" : "成员";
  $("adAvatar").textContent = name.slice(0, 1).toUpperCase();
  loadTasks();
  clearInterval(state.listTimer);
  state.listTimer = setInterval(loadTasks, 5000);
}

async function doLogin() {
  const username = $("ad-user").value.trim();
  const password = $("ad-pass").value;
  const errBox = $("ad-err");
  errBox.hidden = true;
  if (!username || !password) {
    errBox.textContent = "请输入账号与密码";
    errBox.hidden = false;
    return;
  }
  $("ad-login-btn").disabled = true;
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      let detail = "登录失败";
      try { detail = (await res.json()).detail || detail; } catch { /* noop */ }
      errBox.textContent = detail;
      errBox.hidden = false;
      return;
    }
    const body = await res.json();
    state.token = body.access_token;
    state.user = body.user;
    localStorage.setItem("zs_token", state.token);
    localStorage.setItem("zs_user", JSON.stringify(state.user));
    enterDesk();
    toast(`欢迎回来，${state.user.username}`);
  } catch (err) {
    errBox.textContent = errText(err);
    errBox.hidden = false;
  } finally {
    $("ad-login-btn").disabled = false;
  }
}

async function boot() {
  if (!state.token || !state.user) {
    $("ad-login").hidden = false; // 首次访问：直接亮出登录视图
    return;
  }
  try {
    const res = await fetch("/api/me", { headers: { Authorization: "Bearer " + state.token } });
    if (res.ok) enterDesk();
    else logout(); // 401 → logout 亮出登录视图
  } catch {
    $("ad-login").hidden = false; // 网络异常：回到登录页而非白屏
  }
}

/* ============================================================
   任务列表（左侧 rail）
   ============================================================ */
function hunksBadge(t) {
  const h = t.hunks || { total: 0, accepted: 0, rejected: 0 };
  if (!h.total) return '<span class="diff">—</span>';
  return `<span class="diff"><b>✓${h.accepted}</b> <i>✗${h.rejected}</i>/${h.total}</span>`;
}

function renderTasks() {
  const html = state.tasks.map((t) => {
    const active = t.id === (state.activeTask && state.activeTask.id) ? " active" : "";
    const dot = STATUS_DOT[t.status] || "idle";
    const time = (t.created_at || "").slice(11, 16) || "—";
    return `<button class="task${active}" data-task="${t.id}">` +
      `<span class="task-title"><span class="dot ${dot}"></span><span>${esc(t.title || t.goal)}</span></span>` +
      `<span class="task-meta"><span>${time}</span><span>${STATUS_TEXT[t.status] || t.status}</span>${hunksBadge(t)}</span>` +
      `</button>`;
  }).join("") || '<div style="padding:10px;color:#7f8490;font-size:11px">暂无任务 · 点「新建任务」创建</div>';
  $("taskList").innerHTML = html;
  $$("#taskList .task").forEach((el) => {
    el.addEventListener("click", () => openTask(el.getAttribute("data-task")));
  });
}

async function loadTasks() {
  try {
    state.tasks = await api("/tasks");
    renderTasks();
  } catch (err) {
    if (err.status !== 401) toast(errText(err));
  }
}

/* ============================================================
   打开任务：详情 + SSE 全量回放（断线 Last-Event-ID 续传）
   ============================================================ */
function closeTaskStream() {
  if (state.abort) { state.abort.abort(); state.abort = null; }
}

function resetTaskView() {
  state.seq = 0;
  state.seen = new Set();
  state.done = false;
  state.checks = [];
  state.audit = { tools: 0, approvals: 0, blocked: 0, steps: 0 };
  $("flow").innerHTML = "";
  $("flow").style.display = "none";
  $("placeholder").hidden = true;
  ["plan", "exec", "check", "verify", "accept"].forEach((s) => ev(s, ""));
  $("auditList").innerHTML = "";
  $("checkItems").innerHTML = "";
  $("hunkList").innerHTML = "";
  $("fileTabs").innerHTML = "";
  $("diffSummary").textContent = "—";
  $("diffOwns").textContent = "";
  $("diffCnt").textContent = "0";
  $("checksCnt").textContent = "0";
  $("stTools").textContent = "0";
  $("stApprovals").textContent = "0";
  $("stBlocked").textContent = "0";
  $("stSteps").textContent = "0";
  $("sbChecks").textContent = "—";
  $("sbOob").textContent = "0";
  $("sbOob").classList.add("ok");
  $("footSteps").textContent = "steps 0";
  $("ownsTag").hidden = true;
}

async function openTask(id) {
  closeTaskStream();
  const epoch = ++state.epoch;
  let task;
  try {
    task = await api(`/tasks/${id}`);
  } catch (err) {
    toast(errText(err));
    return;
  }
  if (epoch !== state.epoch) return; // 已切到其他任务
  state.activeTask = task;
  resetTaskView();
  renderTaskHead(task);
  renderHunks(task);
  renderTasks();
  $("commitBtn").disabled = true;
  updateGate();
  await startStream(id, epoch, 0); // 打开/刷新：cursor=0 全量回放重建界面（验收 3）
}

function renderTaskHead(task) {
  $("taskTitle").textContent = task.title || task.goal;
  $("sbTask").textContent = (task.id || "").slice(0, 8);
  $("taskWorkspace").textContent = `工作区 ${(task.workspace_dir || task.id).slice(0, 8)} · 演示仓 payment-console`;
  $("taskModeText").textContent = `执行模式：${MODE_LABELS[task.mode] || task.mode}`;
  $("taskSessionText").textContent = `SSE 游标 ${state.seq}`;
  setPill(task.status);
  setEvidence(task.status);
  if (task.owns && task.owns.length) {
    $("ownsTag").hidden = false;
    $("ownsText").textContent = `边界 owns: ${task.owns.join(" · ")} · 越界由策略引擎拦截`;
    $("diffOwns").textContent = `owns: ${task.owns.join(", ")}`;
  }
}

function setPill(status) {
  const el = $("taskStatus");
  const cls = STATUS_PILL[status] ?? "";
  const text = STATUS_TEXT[status] || status;
  el.hidden = false;
  el.className = "pill " + cls;
  const dotCls = cls === "review" ? "run" : (cls === "ok" ? "ok" : (cls === "block" ? "block" : "run"));
  el.innerHTML = `<span class="dot ${dotCls}"></span>${esc(text)}`;
}

/* ---------- 证据链五节点 ---------- */
function ev(stage, cls) {
  $$('.ev-node[data-stage="' + stage + '"]').forEach((node) => {
    node.classList.toggle("active", cls === "active");
    node.querySelector(".ev-dot").className = "ev-dot" + (cls ? " " + cls : "");
  });
}

// 状态 → 证据链推进（task_status 事件与打开任务时均调用；回放幂等）
function setEvidence(status) {
  if (status === "planned") { ev("plan", "active"); return; }
  if (status === "running") { ev("plan", "done"); ev("exec", "active"); return; }
  if (status === "blocked") { ev("plan", "done"); ev("exec", "active"); return; }
  if (status === "verifying") { ev("plan", "done"); ev("exec", "done"); ev("check", "active"); return; }
  if (status === "review") {
    ev("plan", "done"); ev("exec", "done"); ev("check", "done");
    ev("verify", "done"); ev("accept", "active");
    return;
  }
  if (status === "committed") {
    ev("plan", "done"); ev("exec", "done"); ev("check", "done");
    ev("verify", "done"); ev("accept", "done");
  }
}

/* ============================================================
   SSE 消费（fetch + ReadableStream，帧格式 id:/event:/data:\n\n）
   ============================================================ */
async function startStream(taskId, epoch, cursor) {
  state.abort = new AbortController();
  try {
    const res = await fetch(`/api/agentdesk/tasks/${taskId}/events?last_event_id=${cursor}`, {
      headers: {
        Authorization: "Bearer " + state.token,
        Accept: "text/event-stream",
        ...(state.seq > 0 ? { "Last-Event-ID": String(state.seq) } : {}),
      },
      signal: state.abort.signal,
    });
    if (!res.ok) {
      if (res.status === 401) { logout(); return; }
      toast(`SSE 连接失败：${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleFrame(taskId, epoch, frame);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return; // 主动切换任务
  }
  // 断线重连：任务未终态耗尽则从最后 seq 续传（Q7 零丢失）
  if (epoch === state.epoch && !state.done) {
    setTimeout(() => {
      if (epoch === state.epoch && !state.done) startStream(taskId, epoch, state.seq);
    }, 2000);
  }
}

function handleFrame(taskId, epoch, frame) {
  if (epoch !== state.epoch) return;
  let seq = null, type = "", data = {};
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      try { data = JSON.parse(line.slice(5).trim()); } catch { data = {}; }
    }
  }
  if (type === "done") { state.done = true; return; } // done 帧只作关流信号，不计入事件序
  if (seq !== null && !Number.isNaN(seq)) {
    if (state.seen.has(seq)) return; // 重叠连接去重
    state.seen.add(seq);
    if (seq > state.seq) state.seq = seq;
  }
  handleEvent(type, data);
  $("taskSessionText").textContent = `SSE 游标 ${state.seq}`;
}

/* ============================================================
   13 类事件 → 渲染分发（全部幂等，支持全量回放重建）
   ============================================================ */
function handleEvent(type, d) {
  switch (type) {
    case "task_status": onTaskStatus(d); break;
    case "plan": onPlan(d); break;
    case "tool_start": onToolStart(d); break;
    case "tool_result": onToolResult(d); break;
    case "approval_required": onApprovalRequired(d); break;
    case "approval_resolved": onApprovalResolved(d); break;
    case "delta": onDelta(d); break;
    case "check_start": onCheckStart(d); break;
    case "check_result": onCheckResult(d); break;
    case "verify": onVerify(d); break;
    case "summary": onSummary(d); break;
    case "out_of_bounds": onBlocked(type, d); break;
    case "redline_blocked": onBlocked(type, d); break;
    default: break;
  }
  appendAudit(type, d);
}

function ts(d) { return (d && d.ts ? String(d.ts).slice(11, 19) : ""); }

function agentMsg(html, meta) {
  const el = document.createElement("div");
  el.className = "msg agent";
  el.innerHTML = `<div class="meta"><span class="agent-mark"><svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h9M5 17h12"/></svg></span>` +
    `<span class="who">AgentDesk Agent</span><span>${esc(meta || ts(lastData) || "")}</span></div>${html}`;
  $("flow").appendChild(el);
  scrollChat();
  return el;
}

let lastData = null;

function scrollChat() {
  const chat = $("chat");
  chat.scrollTop = chat.scrollHeight;
}

function onTaskStatus(d) {
  lastData = d;
  setPill(d.status);
  setEvidence(d.status);
  if (state.activeTask) state.activeTask.status = d.status;
  updateGate();
}

function onPlan(d) {
  lastData = d;
  const steps = (d.steps || []).map((s, i) => {
    const idx = String(s && s.idx !== undefined ? s.idx : i + 1).padStart(2, "0");
    const title = typeof s === "string" ? s : (s.title || "");
    const detail = typeof s === "string" ? "" : (s.detail || "");
    return `<div class="plan-line"><span class="plan-idx">${esc(idx)}</span><div><b>${esc(title)}</b>${detail ? `<br><span>${esc(detail)}</span>` : ""}</div></div>`;
  }).join("");
  const risks = (d.risks || []).map((r) =>
    `<div class="plan-risk"><svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3z"/><path d="M12 9v5M12 17h.01"/></svg><span>${esc(r)}</span></div>`
  ).join("");
  const needsConfirm = state.activeTask && (state.activeTask.status === "planned");
  const foot = needsConfirm
    ? `<div class="plan-foot" data-plan-foot>
         <button class="btn primary" data-confirm-plan>确认计划并执行</button>
         <button class="btn ghost" data-adjust-plan>调整计划</button>
         <span class="hint">确认后切到「自动编辑」</span>
       </div>`
    : `<div class="plan-foot"><span class="approval-done"><svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>计划已确认或无需确认</span></div>`;
  const el = agentMsg(
    `<div class="bubble" style="padding:0;border:0;background:none"><div class="plan">` +
    `<div class="plan-head"><svg viewBox="0 0 24 24"><path d="M9 5h11M9 12h11M9 19h11M4 5h.01M4 12h.01M4 19h.01"/></svg><b>执行计划</b><span>${esc(String((d.steps || []).length))} 步</span></div>` +
    `<div class="plan-body">${steps}${risks}</div>${foot}</div></div>`,
    `${ts(d)} · 计划`
  );
  const btn = el.querySelector("[data-confirm-plan]");
  if (btn) btn.addEventListener("click", confirmPlan);
  const adj = el.querySelector("[data-adjust-plan]");
  if (adj) adj.addEventListener("click", () => toast("已记入任务：调整计划会进入修订回合，MVP 版请以目标重述新建任务"));
}

async function confirmPlan() {
  const id = state.activeTask.id;
  try {
    await api(`/tasks/${id}/plan/confirm`, { method: "POST", body: JSON.stringify({ action: "approve" }) });
    toast("已确认计划，任务继续执行（模式切到自动编辑）");
  } catch (err) {
    toast(errText(err)); // 重复确认 → 409 no pending plan confirmation
  }
}

/* ---------- 工具卡（tool_start 建卡 / tool_result 回填最近同工具未结算卡） ---------- */
function riskBadge(d) {
  const decided = d.decided || "allow";
  const level = d.risk_level || "";
  const label = decided === "require_approval" ? "待审批" : decided === "deny" ? "已拦截" : `L${level} 自动`;
  const cls = decided === "require_approval" ? "wait" : decided === "deny" ? "" : "auto";
  if (decided === "deny") {
    return `<span class="state" style="color:#a9403a;background:#f7e4e1;border-color:#e6c5c1">已拦截</span>`;
  }
  return `<span class="state ${cls}">${esc(label)}</span>`;
}

function onToolStart(d) {
  lastData = d;
  const el = document.createElement("div");
  el.dataset.toolCard = d.tool;
  el.dataset.settled = "0";
  el.innerHTML = `<div class="tool">` +
    `<div class="tool-head"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M4 9h16"/></svg>` +
    `<span class="tool-name">${esc(d.tool)}</span><span class="arg">${esc(d.args_preview || "")}</span>${riskBadge(d)}</div>` +
    `<div class="code"><span class="ln dim">${esc(d.args_preview || "执行中…")}</span></div></div>`;
  $("flow").appendChild(el);
  scrollChat();
}

function onToolResult(d) {
  lastData = d;
  // 回填最近一张同工具、未结算的工具卡；找不到（如拦截顺序）则独立成卡
  const cards = $$("[data-tool-card]").reverse();
  const card = cards.find((c) => c.dataset.toolCard === d.tool && c.dataset.settled === "0");
  const line = d.ok
    ? `<span class="ln okc">exit ${d.exit_code} · ${d.duration_ms}ms</span>${d.output ? `<span class="ln">${esc(d.output)}</span>` : ""}`
    : `<span class="ln err">exit ${d.exit_code ?? "—"}${d.reason ? ` · ${esc(d.reason)}` : ""}${d.reason_kind ? ` (${esc(d.reason_kind)})` : ""}</span>${d.output ? `<span class="ln">${esc(d.output)}</span>` : ""}`;
  if (card) {
    card.dataset.settled = "1";
    card.querySelector(".code").innerHTML = line;
  } else {
    const el = document.createElement("div");
    el.innerHTML = `<div class="tool"><div class="tool-head"><svg viewBox="0 0 24 24"><path d="M4 5h16v14H4z"/><path d="M4 9h16"/></svg>` +
      `<span class="tool-name">${esc(d.tool)}</span><span class="arg">结果</span><span class="state ${d.ok ? "auto" : ""}" ${d.ok ? "" : 'style="color:#a9403a;background:#f7e4e1;border-color:#e6c5c1"'}>${d.ok ? "完成" : "失败"}</span></div>` +
      `<div class="code">${line}</div></div>`;
    $("flow").appendChild(el);
  }
  if (d.tool) state.audit.tools += 1;
  $("stTools").textContent = state.audit.tools;
  scrollChat();
}

/* ---------- 审批 ---------- */
function onApprovalRequired(d) {
  lastData = d;
  state.audit.approvals += 1;
  $("stApprovals").textContent = state.audit.approvals;
  const el = document.createElement("div");
  el.dataset.approvalCard = d.approval_id;
  const [tool, level] = String(d.scope || "").split(":");
  el.innerHTML = `<div class="approval">` +
    `<div class="approval-head"><svg viewBox="0 0 24 24"><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="M9 12l2 2 4-4"/></svg><b>需要你确认</b><span class="risk">${esc(level || "")} · ${esc(tool || "")}</span></div>` +
    `<div class="approval-body">` +
    `<div class="cmd"><span class="prompt">$</span>${esc(d.command || "")}</div>` +
    `<div class="approval-note">${esc(d.reason || "策略引擎要求人工审批。")}作用域：${esc(d.scope || "")}。执行在任务工作区内进行。</div>` +
    `<div class="approval-actions" data-approval-actions>` +
    `<button class="btn primary sm" data-approve="once">仅本次允许</button>` +
    `<button class="btn sm" data-approve="always">本项目总是允许</button>` +
    `<button class="btn ghost sm" data-approve="deny">拒绝</button></div>` +
    `<div class="approval-done" data-approval-done hidden><svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg><span data-approval-done-text></span></div>` +
    `</div></div>`;
  $$("[data-approve]", el).forEach((btn) => {
    btn.addEventListener("click", () => decideApproval(d.approval_id, btn.getAttribute("data-approve"), el));
  });
  $("flow").appendChild(el);
  scrollChat();
}

async function decideApproval(approvalId, decision, card) {
  const actions = card.querySelector("[data-approval-actions]");
  const done = card.querySelector("[data-approval-done]");
  const doneText = card.querySelector("[data-approval-done-text]");
  try {
    await api(`/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
  } catch (err) {
    toast(errText(err)); // 双击 → 409 already resolved
    return;
  }
  actions.hidden = true;
  done.hidden = false;
  if (decision === "deny") {
    done.style.color = "#a9403a";
    doneText.textContent = "已拒绝：Agent 停止执行该命令";
    toast("已拒绝。Agent 将收到拒绝反馈并自纠");
  } else {
    doneText.textContent = decision === "always" ? "已允许：该项目后续同类命令免确认（已写入策略）" : "已允许本次执行";
    toast(decision === "always" ? "已写入项目策略：同类命令免确认" : "已允许本次命令");
  }
}

function onApprovalResolved(d) {
  lastData = d;
  const card = $(`[data-approval-card="${d.approval_id}"]`);
  if (card) {
    const actions = card.querySelector("[data-approval-actions]");
    const done = card.querySelector("[data-approval-done]");
    const doneText = card.querySelector("[data-approval-done-text]");
    if (actions) actions.hidden = true;
    if (done) {
      done.hidden = false;
      if (d.decision === "deny") done.style.color = "#a9403a";
      doneText.textContent = d.decision === "deny"
        ? "已拒绝：Agent 停止执行该命令"
        : d.decision === "always" ? "已允许：本项目后续同类命令免确认" : "已允许本次执行";
    }
  }
}

/* ---------- 叙述 / 检查 / 验证 / 摘要 / 拦截 ---------- */
function onDelta(d) {
  lastData = d;
  agentMsg(`<div class="bubble">${esc(d.text || "")}</div>`, `${ts(d)} · 叙述`);
}

function onCheckStart(d) {
  lastData = d;
  state.checks = [];
  const el = agentMsg(
    `<div class="card"><div class="card-head"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2 2"/></svg><b>自动检查</b><span class="right">运行中</span></div>` +
    `<div class="card-body">${(d.commands || []).map((c) =>
      `<div class="check-row"><span class="check-icon wait" data-check-row="${esc(c)}"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2 2"/></svg></span><span class="name">${esc(c)}</span><span class="dur">等待结果</span></div>`
    ).join("")}</div></div>`,
    `${ts(d)} · 检查开始`
  );
  el.dataset.checkCard = "1";
  // 右侧检查面板同步初始化
  $("checkItems").innerHTML = (d.commands || []).map((c) =>
    `<div class="check-item"><div class="check-item-top"><span class="cmd2">${esc(c)}</span><span class="st wait" data-panel-check="${esc(c)}">运行中</span></div><div class="out">等待结果</div></div>`
  ).join("");
  $("checksCnt").textContent = String((d.commands || []).length);
  ev("check", "active");
}

function onCheckResult(d) {
  lastData = d;
  state.checks.push(d);
  const iconCls = d.ok ? "ok" : "bad";
  const svg = d.ok ? '<path d="m5 13 4 4L19 7"/>' : '<path d="M6 6l12 12M18 6 6 18"/>';
  // 会话流检查卡行更新
  const row = document.querySelector(`[data-check-row="${CSS.escape(d.command)}"]`);
  if (row) {
    row.className = `check-icon ${iconCls}`;
    row.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
    const dur = row.parentElement.querySelector(".dur");
    if (dur) dur.textContent = `exit ${d.exit_code} · 第 ${state.checks.filter((x) => x.command === d.command).length} 次`;
  }
  // 右侧检查面板更新
  const panel = document.querySelector(`[data-panel-check="${CSS.escape(d.command)}"]`);
  if (panel) {
    const item = panel.closest(".check-item");
    panel.className = `st ${d.ok ? "ok" : "bad"}`;
    panel.textContent = d.ok ? "通过" : "失败";
    item.querySelector(".out").textContent = d.ok ? `exit ${d.exit_code}` : `exit ${d.exit_code} · 将回灌修复（至多 2 轮）`;
  }
  // 顶栏与审计
  const okCount = state.checks.filter((x) => x.ok).length;
  $("sbChecks").textContent = `${okCount}/${state.checks.length}`;
  if (!d.ok) {
    state.audit.blocked += 1;
    $("stBlocked").textContent = state.audit.blocked;
    $("sbOob").classList.remove("ok");
  }
}

function onVerify(d) {
  lastData = d;
  agentMsg(
    `<div class="bubble" style="padding:0;border:0;background:none"><div class="card verify">` +
    `<div class="card-head"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg><b>独立验证</b><span class="right">${(d.criteria || []).length} 项判定</span></div>` +
    `<div class="card-body"><div class="criteria">${(d.criteria || []).map((c) =>
      `<div class="criterion"><svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg><span>${esc(c)}</span></div>`
    ).join("")}</div>` +
    `<div class="note"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg><span>验证基于 check 结果：${(d.results || []).map((r) => `${esc(r.command)} exit ${r.exit_code}`).join(" · ") || "—"}</span></div>` +
    `</div></div></div>`,
    `${ts(d)} · 验证`
  );
}

function onSummary(d) {
  lastData = d;
  const review = d.outcome === "review";
  state.audit.steps = d.steps || state.audit.steps;
  $("stSteps").textContent = state.audit.steps;
  $("footSteps").textContent = `steps ${state.audit.steps} · tokens ${d.total_tokens || 0}`;
  const ds = d.diff_stat || {};
  agentMsg(
    `<div class="summary"><div class="summary-head"><b>交付摘要</b><span class="badge ${review ? "" : "partial"}">${review ? "待验收" : "部分完成"}</span></div>` +
    `<div class="summary-body">` +
    `<div class="sum-row"><div class="k">改动</div><div class="v">${esc(ds.files || "—")}${ds.additions !== undefined ? ` · <b style="color:#2e7d5b">+${esc(ds.additions)}</b> <b style="color:#a9403a">−${esc(ds.deletions)}</b>` : ""}</div></div>` +
    `<div class="sum-row"><div class="k">检查</div><div class="v">${d.checks === "passed" ? "全部通过" : "未通过（已如实降级）"}</div></div>` +
    `<div class="sum-row"><div class="k">轮次</div><div class="v">${esc(d.steps || 0)} 轮 · tokens ${esc(d.total_tokens || 0)}</div></div>` +
    (d.error ? `<div class="sum-row"><div class="k">异常</div><div class="v" style="color:#a9403a">${esc(d.error)}（runner 兜底转 partial）</div></div>` : "") +
    `<div class="sum-row"><div class="k">下一步</div><div class="v">${review ? "在「改动」面板逐块评审后提交" : "任务未达验收标准，可查看证据后归档"}</div></div>` +
    `</div></div>`,
    `${ts(d)} · 摘要`
  );
  if (review) {
    loadTasks(); // review 态：详情接口会惰性生成 hunk，刷新列表徽标
    refreshTaskDetail();
  }
  updateGate();
}

function onBlocked(type, d) {
  lastData = d;
  state.audit.blocked += 1;
  $("stBlocked").textContent = state.audit.blocked;
  $("sbOob").textContent = state.audit.blocked;
  $("sbOob").classList.remove("ok");
  const text = type === "out_of_bounds"
    ? `越界写被拦截：${esc(d.tool || "")} → ${esc(d.path || "")}（不在 owns 声明内）`
    : `红线命令被拦截：${esc(d.command || "")} · 命中模式 ${esc(d.pattern || "")}`;
  agentMsg(`<div class="bubble" style="border-color:#e6c5c1;background:#fff8f6">${text}</div>`, `${ts(d)} · ${type === "out_of_bounds" ? "越界拦截" : "红线拦截"}`);
}

/* ============================================================
   右侧面板：改动（hunk 评审）
   ============================================================ */
function renderHunks(task) {
  const hunks = task.hunk_list || [];
  const summary = task.hunks || { total: 0, accepted: 0, rejected: 0, pending: 0 };
  $("diffCnt").textContent = String(summary.total);
  $("diffSummary").textContent = hunks.length
    ? `${hunks.length} 文件块 · 评审 ${summary.accepted}/${summary.total}`
    : (task.status === "review" ? "暂无 diff（工作区与基线一致）" : "任务进入 review 态后生成改动集");
  $("fileTabs").innerHTML = hunks.map((h) =>
    `<span class="file-tab">${esc(shortPath(h.path))}<b class="plus">+${h.additions}</b>${h.deletions ? `<b class="minus">−${h.deletions}</b>` : ""}</span>`
  ).join("");
  $("hunkList").innerHTML = hunks.map((h) => hunkCard(h, task.status === "review")).join("");
  bindHunkButtons();
  updateAccept();
}

function shortPath(p) {
  const i = String(p).lastIndexOf("/");
  return i >= 0 ? String(p).slice(i + 1) : String(p);
}

// unified diff 文本 → 着色行（+ 加 / − 删 / @@ 元信息 / 其余上下文）
function diffRows(content) {
  return String(content || "").split("\n").map((line) => {
    let cls = "ctx", sign = "";
    if (/^\+\+\+|^---/.test(line)) { cls = "dim"; sign = ""; }
    else if (line.startsWith("@@")) { cls = "dim"; sign = ""; }
    else if (line.startsWith("+")) { cls = "add"; sign = "+"; }
    else if (line.startsWith("-")) { cls = "del"; sign = "-"; }
    else sign = "";
    return `<div class="row"><span class="gutter"></span><span class="sign">${sign}</span><span class="line ${cls}">${esc(line)}</span></div>`;
  }).join("");
}

function hunkCard(h, actionable) {
  const decided = h.status === "accepted" ? "accepted" : h.status === "rejected" ? "rejected" : "";
  const decText = h.status === "accepted" ? "已接受" : h.status === "rejected" ? "已拒绝" : "待确认";
  const buttons = actionable && h.status === "pending"
    ? `<button class="btn sm" data-act="accept" data-hunk="${h.id}">接受</button>
       <button class="btn ghost sm" data-act="reject" data-hunk="${h.id}">拒绝</button>`
    : "";
  return `<div class="hunk" data-hunk-id="${h.id}">
    <div class="hunk-head"><span class="fname">${esc(h.path)}</span><span class="ev">块 ${h.idx + 1} · +${h.additions} −${h.deletions}</span></div>
    <div class="diff">${diffRows(h.content)}</div>
    <div class="hunk-foot">${buttons}<span class="state"><span class="decision ${decided}" data-dec="${h.id}">${decText}</span></span></div>
  </div>`;
}

function bindHunkButtons() {
  $$("#hunkList [data-act]").forEach((btn) => {
    btn.addEventListener("click", () => decideHunk(btn.getAttribute("data-hunk"), btn.getAttribute("data-act")));
  });
}

async function decideHunk(hunkId, action) {
  const id = state.activeTask.id;
  try {
    const res = await api(`/tasks/${id}/hunks`, {
      method: "POST",
      body: JSON.stringify({ hunk_id: hunkId, action }),
    });
    state.activeTask.hunks = res.hunks;
    const dec = document.querySelector(`[data-dec="${hunkId}"]`);
    if (dec) {
      dec.className = "decision " + (action === "accept" ? "accepted" : "rejected");
      dec.textContent = action === "accept" ? "已接受" : "已拒绝";
    }
    $$(`#hunkList [data-hunk="${hunkId}"]`).forEach((b) => { b.disabled = true; });
    toast(action === "accept" ? "已接受该块改动，未接受的改动不会进入提交" : "已拒绝该块改动，改动留在工作区但不进提交");
    updateAccept();
  } catch (err) {
    toast(errText(err));
  }
}

function updateAccept() {
  const h = (state.activeTask && state.activeTask.hunks) || { total: 0, accepted: 0, rejected: 0 };
  $("acceptCount").textContent = `${h.accepted + h.rejected} / ${h.total}`;
  updateGate();
}

/* ---------- 门禁与提交 ---------- */
function canCommit() {
  const t = state.activeTask;
  const h = (t && t.hunks) || {};
  return !!t && t.status === "review" && h.total > 0 && h.accepted === h.total;
}

function updateGate() {
  const t = state.activeTask;
  if (!t) return;
  const h = t.hunks || { total: 0, accepted: 0, rejected: 0, pending: 0 };
  const gate = $("gateBox");
  const checksOk = state.checks.length > 0 && state.checks.every((c) => c.ok);
  if (t.status !== "review") {
    gate.className = "gate gate-fail";
    $("gateTitle").textContent = "暂不可提交";
    $("gateText").textContent = `当前状态 ${STATUS_TEXT[t.status] || t.status}：提交需任务进入 review 态。`;
  } else if (h.total === 0) {
    gate.className = "gate gate-fail";
    $("gateTitle").textContent = "暂不可提交";
    $("gateText").textContent = "工作区与基线无差异，没有可提交的改动。";
  } else if (h.accepted !== h.total) {
    gate.className = "gate gate-fail";
    $("gateTitle").textContent = "暂不可提交";
    $("gateText").textContent = `改动评审未完成：已接受 ${h.accepted}/${h.total}（待确认 ${h.pending} · 已拒绝 ${h.rejected}）。未接受的块不会进入提交，请逐块确认。`;
  } else {
    gate.className = "gate";
    $("gateTitle").textContent = "可以提交";
    $("gateText").textContent = `全部 ${h.total} 块改动已接受；提交时将重跑 pytest + ruff 门禁${checksOk ? "（检查已全绿）" : ""}。`;
  }
  $("commitBtn").disabled = !canCommit();
  $("commitHint").textContent = t.status !== "review"
    ? "检查与验收完成后才能提交"
    : h.accepted !== h.total
      ? `还有 ${h.total - h.accepted - h.rejected} 块待确认${h.rejected ? ` · 已拒绝 ${h.rejected}` : ""}`
      : "门禁通过 · 提交将在服务端重跑检查";
}

async function doCommit() {
  if (!canCommit()) return;
  $("commitBtn").disabled = true;
  const t = state.activeTask;
  try {
    const res = await api(`/tasks/${t.id}/commit`, { method: "POST" });
    setPill("committed");
    setEvidence("committed");
    t.status = "committed";
    ev("accept", "done");
    $("commitBtn").innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>已提交';
    $("commitHint").textContent = `${res.status} · ${res.hunks ? res.hunks.total : 0} 块改动 · checks ${Object.entries(res.checks || {}).map(([k, v]) => `${k}:${v ? "✓" : "✗"}`).join(" ")}`;
    toast("已提交：改动已 git commit 到任务工作区（agent: 前缀）");
    loadTasks();
  } catch (err) {
    $("commitBtn").disabled = false;
    toast(`提交被门禁拦截：${errText(err)}`); // 409 带原因
  }
}

async function refreshTaskDetail() {
  if (!state.activeTask) return;
  try {
    const task = await api(`/tasks/${state.activeTask.id}`);
    state.activeTask = task;
    renderHunks(task);
    updateGate();
  } catch { /* 忽略瞬时失败 */ }
}

/* ============================================================
   审计面板（事件顺序留痕）
   ============================================================ */
const AUDIT_LABEL = {
  task_status: "状态", plan: "计划", tool_start: "工具调用", tool_result: "工具结果",
  approval_required: "命令需审批", approval_resolved: "审批决策", delta: "叙述",
  check_start: "检查开始", check_result: "检查结果", verify: "独立验证", summary: "交付摘要",
  out_of_bounds: "越界拦截", redline_blocked: "红线拦截",
};

function appendAudit(type, d) {
  const list = $("auditList");
  if (list.querySelector(".audit-item.wait")) list.innerHTML = "";
  const item = document.createElement("div");
  const bad = type === "out_of_bounds" || type === "redline_blocked"
    || (type === "tool_result" && d.ok === false)
    || (type === "summary" && d.outcome === "partial");
  item.className = "audit-item " + (bad ? "bad" : "done");
  let text = `<b>${AUDIT_LABEL[type] || type}</b>`;
  if (type === "task_status") text += ` ${esc(STATUS_TEXT[d.status] || d.status)}${d.note ? ` · ${esc(d.note)}` : ""}`;
  else if (type === "tool_start") text += ` ${esc(d.tool)} · ${esc(d.args_preview || "")}`;
  else if (type === "tool_result") text += ` ${esc(d.tool)} · ${d.ok ? `exit ${d.exit_code}` : `失败 ${esc(d.reason || d.exit_code)}`}`;
  else if (type === "approval_required") text += ` ${esc(d.command || "")} · ${esc(d.scope || "")}`;
  else if (type === "approval_resolved") text += ` ${esc(d.decision)} · ${esc(d.command || "")}`;
  else if (type === "check_result") text += ` ${esc(d.command)} · ${d.ok ? "通过" : `exit ${d.exit_code}`}`;
  else if (type === "summary") text += ` ${esc(d.outcome)}`;
  else if (type === "out_of_bounds") text += ` ${esc(d.tool)} → ${esc(d.path || "")}`;
  else if (type === "redline_blocked") text += ` ${esc(d.command || "")}`;
  else if (type === "delta") text += ` ${esc((d.text || "").slice(0, 60))}`;
  item.innerHTML = `<span class="audit-time">${ts(d) || "—"}</span><span class="audit-text">${text}</span><span class="audit-actor">agentdesk · seq</span>`;
  list.appendChild(item);
  list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

/* ============================================================
   新建任务 / 模式菜单 / 交互杂项
   ============================================================ */
function openPalette() {
  $("palette").classList.add("open");
  $("npMode").value = state.defaultMode;
  setTimeout(() => $("npGoal").focus(), 30);
}
function closePalette() { $("palette").classList.remove("open"); }

async function createTask() {
  const goal = $("npGoal").value.trim();
  if (!goal) { toast("目标不能为空"); return; }
  const owns = $("npOwns").value.split(",").map((s) => s.trim()).filter(Boolean);
  const title = $("npTitle").value.trim() || null;
  $("npSubmit").disabled = true;
  try {
    const task = await api("/tasks", {
      method: "POST",
      body: JSON.stringify({ goal, owns, mode: $("npMode").value, title }),
    });
    closePalette();
    $("npGoal").value = ""; $("npOwns").value = ""; $("npTitle").value = "";
    toast(`任务已创建并入队（${MODE_LABELS[task.mode] || task.mode}）`);
    await loadTasks();
    openTask(task.id);
  } catch (err) {
    toast(errText(err));
  } finally {
    $("npSubmit").disabled = false;
  }
}

function setMode(key, silent) {
  if (!MODE_LABELS[key]) return;
  state.defaultMode = key;
  $("modeLabel").textContent = MODE_LABELS[key];
  $$("#modeMenu .menu-item").forEach((item) => {
    item.classList.toggle("sel", item.getAttribute("data-mode") === key);
  });
  if (!silent) toast(`新建任务默认模式：${MODE_LABELS[key]}`);
}

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.getAttribute("data-pane") === name));
  ["diff", "checks", "preview", "audit"].forEach((n) => { $("pane-" + n).hidden = n !== name; });
}

/* ---------- 事件绑定 ---------- */
$("ad-login-btn").addEventListener("click", doLogin);
$("ad-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("ad-user").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ad-pass").focus(); });
$("adLogout").addEventListener("click", logout);

$("btnNewTask").addEventListener("click", openPalette);
$("btnRefresh").addEventListener("click", () => { loadTasks(); toast("任务列表已刷新"); });
$("npCancel").addEventListener("click", closePalette);
$("npSubmit").addEventListener("click", createTask);
$("palette").addEventListener("click", (e) => { if (e.target === $("palette")) closePalette(); });

$("commitBtn").addEventListener("click", doCommit);
$("btnReloadTask").addEventListener("click", () => {
  if (state.activeTask) { openTask(state.activeTask.id); toast("已从 seq 0 全量回放重建界面"); }
});

const modeBtn = $("modeBtn"), modeMenu = $("modeMenu");
modeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  modeMenu.classList.toggle("open");
  modeBtn.setAttribute("aria-expanded", modeMenu.classList.contains("open") ? "true" : "false");
});
$$("#modeMenu .menu-item").forEach((item) => {
  item.addEventListener("click", () => {
    setMode(item.getAttribute("data-mode"));
    modeMenu.classList.remove("open");
  });
});
document.addEventListener("click", () => modeMenu.classList.remove("open"));

$$(".tab").forEach((tab) => tab.addEventListener("click", () => switchTab(tab.getAttribute("data-pane"))));

$("modelBtn").addEventListener("click", () =>
  toast("模型经 MODEL_GATEWAY_BASE_URL 指向模型网关（演示容器为 fake-openai）；策略由管理员配置"));
$("compAdd").addEventListener("click", () => toast("补充上下文面板属完整版能力；MVP 目标在新建任务时一次性给出"));
$("sendBtn").addEventListener("click", () => toast("MVP 的任务目标在新建任务时一次性给出（右上 ⌘K 或左侧「新建任务」）"));
$("composerInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); toast("MVP 的任务目标在新建任务时一次性给出"); }
});
$("composerInput").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 90) + "px";
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && e.shiftKey && !$("palette").classList.contains("open")) {
    e.preventDefault();
    const idx = MODE_ORDER.indexOf(state.defaultMode);
    setMode(MODE_ORDER[(idx + 1) % MODE_ORDER.length]);
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openPalette();
  }
  if (e.key === "Escape") { closePalette(); modeMenu.classList.remove("open"); }
});

boot();
