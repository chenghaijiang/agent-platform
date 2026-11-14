/* ============================================================
   知源 · 企业知识问答工作台（T09 前端）
   纯静态 vanilla JS 单页：hash 路由 + fetch(POST) SSE 解析。
   交互与视觉对齐 2026/docs/prototype/mvp-mockup.html（验收基准）。
   ============================================================ */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem("zs_token") || "",
  user: JSON.parse(localStorage.getItem("zs_user") || "null"),
  sessions: [],
  currentSessionId: null,
  sending: false,
  kbPollTimer: null,
  kbs: [],
  chunksCache: new Map(), // task_id → 切片预览（succeeded 后不变，缓存避免轮询重复拉取）
  chunksOpen: new Set(),  // 当前展开切片预览的任务 id
  lastTasksKey: "",       // 上次任务列表 JSON：数据未变时跳过 DOM 重建（避免打断用户点击）
  // ---- 统一工作台（ADR-014~017 一期前端）----
  profiles: [],           // 可选智能体（GET /workbench/profiles）
  profileKey: "knowledge-assistant", // 新会话绑定的智能体（Q3A：换智能体 = 开新会话）
  currentProfile: null,   // 当前会话绑定的智能体
  streamAbort: null,      // 会话流 SSE 的 AbortController（切会话/登出时断开）
  streamEpoch: 0,         // 会话流代数：递增使旧流的断线重连逻辑失效
  seenSeq: 0,             // 已消费最大 seq（Last-Event-ID 续传游标）
  renderedSeqs: new Set(),// 已渲染 seq（POST 直播与会话流双路去重）
  pendingQuestion: null,  // POST SSE 直播中的 user 文本（会话流重复帧去重）
  qaAnswer: "",           // POST SSE 直播中的 assistant 累积文本（同上）
  qaDoneSeq: 0,           // 最近 done 帧的 assistant seq（会话流重复帧去重）
  // ---- Agent 内嵌（harness 渲染体系移植，ADR-019 后续）----
  qaModel: localStorage.getItem("zs_qa_model") || "", // 问答模式模型覆盖（空 = 平台默认）
  hwModel: "",            // harness runtime 当前模型（/api/health 快照）
  hwBusy: false,          // Agent turn 运行中
  hwEpoch: 0,             // harness events 流代数（切会话/登出失效）
  hwAbort: null,          // harness events SSE AbortController
  hwTraceIds: new Map(    // platform session id → Set(traceId)（localStorage 持久化）
    Object.entries(JSON.parse(localStorage.getItem("zs_hw_traces") || "{}")
      ).map(([k, v]) => [k, new Set(v)])),
  hwActiveSession: null,  // 发起当前 harness turn 的 platform 会话 id（跨会话事件归属判定）
};

/* ============================================================
   通用：toast / 转义 / API 客户端
   ============================================================ */
function toast(msg, warn) {
  const t = document.createElement("div");
  t.className = "toast" + (warn ? " warn" : "");
  t.textContent = msg;
  $("toast-wrap").appendChild(t);
  setTimeout(() => {
    t.style.transition = "opacity .4s";
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 400);
  }, 2600);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errText(err) {
  return String(err && err.message ? err.message : err);
}

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
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
      detail = typeof body.detail === "string" ? body.detail : (body.detail && body.detail.message) || detail;
    } catch { /* 保留 statusText */ }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

/** harness 网关 fetch：经平台认证反代 /api/harness/*，返回 raw Response（与 harness 客户端同语义）。 */
async function hwFetch(path, opts = {}) {
  const res = await fetch("/api/harness" + path, {
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
  return res;
}

function persistHwTraces() {
  const flat = {};
  for (const [k, v] of state.hwTraceIds) flat[k] = [...v];
  localStorage.setItem("zs_hw_traces", JSON.stringify(flat));
}

/* ============================================================
   登录 / 登出 / 启动恢复
   ============================================================ */
function logout() {
  state.token = "";
  state.user = null;
  state.currentSessionId = null;
  state.sessions = [];
  state.currentProfile = null;
  state.streamEpoch += 1; // 使会话流断线重连逻辑失效
  if (state.streamAbort) { state.streamAbort.abort(); state.streamAbort = null; }
  state.hwEpoch += 1;     // 使 harness events 流重连失效
  state.hwBusy = false;
  if (state.hwAbort) { state.hwAbort.abort(); state.hwAbort = null; }
  localStorage.removeItem("zs_token");
  localStorage.removeItem("zs_user");
  stopKbPoll();
  $("view-app").classList.remove("active");
  $("view-login").classList.add("active");
  $("lg-pass").value = "";
}

function enterApp() {
  $("view-login").classList.remove("active");
  $("view-app").classList.add("active");
  renderUserIdentity();
  applyRoleVisibility();
  renderSessions();
  loadProfiles();
  // 保持刷新前的路由（#/kb、#/users）；非法或空路由才回落到对话页
  const current = (location.hash || "").replace(/^#\//, "");
  if (!["chat", "kb", "users"].includes(current)) location.hash = "#/chat";
  handleRoute();
}

function renderUserIdentity() {
  const name = state.user.username;
  $("user-name").textContent = state.user.role === "admin" ? `${name}（管理员）` : name;
  $("user-avatar").textContent = name.slice(0, 1).toUpperCase();
  $("user-role-chip").textContent = state.user.role === "admin" ? "平台管理员" : "普通成员";
}

function applyRoleVisibility() {
  const isAdmin = state.user.role === "admin";
  $("nav-kb").style.display = isAdmin ? "" : "none";
  $("nav-users").style.display = isAdmin ? "" : "none";
}

async function doLogin() {
  const username = $("lg-user").value.trim();
  const password = $("lg-pass").value;
  const errBox = $("login-error");
  errBox.hidden = true;
  if (!username || !password) {
    errBox.textContent = "请输入账号与密码";
    errBox.hidden = false;
    return;
  }
  const btn = $("login-btn");
  btn.disabled = true;
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
    enterApp();
    toast(`欢迎回来，${state.user.username}`);
  } catch (err) {
    errBox.textContent = errText(err);
    errBox.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

async function boot() {
  if (!state.token || !state.user) {
    $("view-login").classList.add("active");
    return;
  }
  try {
    await api("/me"); // 校验 token 有效性
    enterApp();
  } catch {
    /* 401 已在 api() 内登出 */
  }
}

/* ============================================================
   Hash 路由
   ============================================================ */
function handleRoute() {
  const route = (location.hash || "#/chat").replace(/^#\//, "");
  const target = ["chat", "kb", "users"].includes(route) ? route : "chat";
  if ((target === "kb" || target === "users") && state.user && state.user.role !== "admin") {
    toast("知识库与用户管理仅平台管理员可见", true);
    location.hash = "#/chat";
    return;
  }
  document.querySelectorAll(".topbar-nav button").forEach((b) => {
    b.classList.toggle("on", b.dataset.route === target);
  });
  $("route-chat").style.display = target === "chat" ? "flex" : "none";
  $("route-kb").hidden = target !== "kb";
  $("route-users").hidden = target !== "users";

  if (target === "chat") loadSessions();
  if (target === "kb") { loadKbPage(); startKbPoll(); } else { stopKbPoll(); }
  if (target === "users") loadUsersPage();
}

document.querySelectorAll(".topbar-nav button").forEach((btn) => {
  btn.addEventListener("click", () => { location.hash = "#/" + btn.dataset.route; });
});
window.addEventListener("hashchange", handleRoute);

/* ============================================================
   会话列表
   ============================================================ */
async function loadSessions() {
  if (!state.token) return;
  try {
    if (!state.profiles.length) await loadProfiles(); // openSession 的引擎分支判定依赖 profiles（首次进入时序保障）
    state.sessions = await api("/workbench/sessions");
    renderSessions();
    if (!state.currentSessionId && state.sessions.length) {
      openSession(state.sessions[0].id);
    }
  } catch (err) {
    toast(errText(err), true);
  }
}

function renderSessions() {
  const list = $("conv-list");
  if (!state.sessions.length) {
    list.innerHTML = '<div style="padding:14px 12px;color:var(--ink-faint);font-size:12.5px">暂无会话，点击上方「新会话」开始</div>';
    return;
  }
  list.innerHTML = state.sessions
    .map((s) => {
      const on = s.id === state.currentSessionId ? " on" : "";
      const time = s.created_at ? s.created_at.slice(5, 16).replace("T", " ") : "";
      const pv = state.profiles.find((p) => p.key === (s.profile_key || "knowledge-assistant"));
      return `<div class="conv-item${on}" data-sid="${s.id}">
        <div class="t">${esc(s.title || "新会话")}</div>
        <div class="m">${esc(time)}${pv ? ` · <span class="pv">${esc(pv.display_name)}</span>` : ""}</div>
        <button class="conv-del" data-del="${s.id}" type="button" title="删除会话">×</button>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".conv-item").forEach((el) => {
    el.addEventListener("click", () => openSession(el.dataset.sid));
  });
  list.querySelectorAll(".conv-del").forEach((el) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation(); // 不触发会话切换
      deleteSession(el.dataset.del);
    });
  });
}

async function deleteSession(sessionId) {
  if (!confirm("删除该会话？聊天记录将一并清除，名下任务保留。")) return;
  try {
    await api(`/workbench/sessions/${sessionId}`, { method: "DELETE" });
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = null;
      state.streamEpoch += 1; // 使旧会话流断线重连失效
      if (state.streamAbort) { state.streamAbort.abort(); state.streamAbort = null; }
      state.hwEpoch += 1;
      if (state.hwAbort) { state.hwAbort.abort(); state.hwAbort = null; }
      $("chat-inner").innerHTML =
        '<div class="chat-empty"><div class="t">向知识助手提问</div><div class="s">回答基于你有权访问的知识库生成；右上角可选智能体（代码工程模式）与模型</div></div>';
      applyProfileChrome();
    }
    renderSessions();
    toast("会话已删除");
  } catch (err) {
    toast(errText(err), true);
  }
}

async function newSession() {
  try {
    const s = await api("/workbench/sessions", {
      method: "POST",
      body: JSON.stringify({ profile_key: state.profileKey, title: null }),
    });
    state.sessions.unshift(s);
    state.currentSessionId = s.id;
    state.currentProfile = profileOf(s.profile_key);
    $("chat-inner").innerHTML =
      '<div class="chat-empty"><div class="t"></div><div class="s"></div></div>'; // 空态占位，由 applyProfileChrome 填文案
    renderSessions();
    applyProfileChrome();
    // 问答会话立即接入会话流；Agent 会话的容器与事件流由 sendAgentTurn / openSession 分支接管
    const np = profileOf(s.profile_key);
    if (!np || np.engine_kind === "qa_graph") startSessionStream(s.id);
    else setStreamState("SSE 未连接", false); // 清除上一会话流的状态残留（Agent 流由发送/openSession 接管）
    toast(`已创建新会话 · 绑定智能体「${agentName()}」`);
    $("composer-input").focus();
  } catch (err) {
    toast(errText(err), true);
  }
}

/* ============================================================
   历史渲染（Run 记录 → 问答块 + 引用面板）
   ============================================================ */
function scrollBottom() {
  const sc = $("chat-scroll");
  if (sc) sc.scrollTop = sc.scrollHeight;
}

const SEAL_MAP = {
  confidential: ["seal-jiemi", "机密"],
  internal: ["seal-neibu", "内部"],
  public: ["seal-gongkai", "公开"],
};

function sealOf(classification) {
  return SEAL_MAP[classification] || ["seal-neibu", "内部"];
}

function fillGov(strip, runId) {
  const items = [
    "Guardrails 输入脱敏 · 已执行",
    "检索 ACL 过滤 · 已执行",
    "输出敏感识别 · 已执行",
    runId ? `审计已记录 · Run ${runId.slice(0, 8)}` : "审计已记录",
  ];
  strip.innerHTML = items
    .map((g, i) => `<span class="g${i === items.length - 1 ? " audit" : ""}">${esc(g)}</span>`)
    .join("");
  strip.hidden = false;
}

function appendQuestion(inner, text) {
  const wrap = document.createElement("div");
  wrap.className = "q-bubble";
  wrap.innerHTML = `<div class="txt">${esc(text)}</div>`;
  inner.appendChild(wrap);
  return wrap; // 供 POST 直播用落库文本（脱敏后）替换
}

function buildAnswerBlock(inner, runId) {
  const block = document.createElement("div");
  block.className = "a-block";
  block.innerHTML = `
    <div class="a-head"><span class="who">${esc(agentName())}</span><span class="meta">${runId ? "Run " + runId.slice(0, 8) : ""}</span></div>
    <div class="a-body"><span class="empty-hint">正在检索知识库…</span></div>
    <div class="gov-strip" hidden></div>`;
  inner.appendChild(block);
  return block;
}

async function openSession(sessionId) {
  state.currentSessionId = sessionId;
  state.streamEpoch += 1; // 使旧会话流的断线重连失效
  if (state.streamAbort) { state.streamAbort.abort(); state.streamAbort = null; }
  state.hwEpoch += 1;     // 断开旧 harness events 流（Agent 分支稍后 startHwStream 重开）
  if (state.hwAbort) { state.hwAbort.abort(); state.hwAbort = null; }
  state.renderedSeqs = new Set();
  state.seenSeq = 0;
  state.pendingQuestion = null;
  state.qaAnswer = "";
  state.qaDoneSeq = 0;
  renderSessions();
  const inner = $("chat-inner");
  inner.innerHTML = "";
  try {
    const session = state.sessions.find((x) => x.id === sessionId) || null;
    state.currentProfile = session ? profileOf(session.profile_key) : null;
    applyProfileChrome(); // chip/占位文案随会话绑定智能体切换（含刷新回放路径）
    const p = currentProfileOf();
    if (p && p.engine_kind !== "qa_graph") {
      // Agent 会话：harness 渲染容器 + events 流（连接即 replay 本会话历史，按 traceId 过滤）
      inner.innerHTML = '<div class="chat-stream" id="hw-stream"></div><div class="hw-approvals" id="hw-approvals"></div>';
      resetHwSession();
      startHwStream();
      return;
    }
    // 消息信封回放（ADR-015 决策 5）：chat_messages 落库 = 重启/切会话重建聊天流的数据源
    const body = await api(`/workbench/sessions/${sessionId}/messages?after_seq=0`);
    if (!body.messages.length) {
      inner.innerHTML = `<div class="chat-empty"><div class="t">向知识助手提问</div><div class="s">回答基于你有权访问的知识库生成</div></div>`;
      applyProfileChrome(); // 按当前 Profile 覆写空态文案
    } else {
      for (const m of body.messages) renderEnvelope(m);
      scrollBottom();
    }
    startSessionStream(sessionId); // 接入会话流：尾随直播新消息（含审批卡片）
  } catch (err) {
    toast(errText(err), true);
  }
}

/* ============================================================
   提问：fetch(POST) SSE 流式解析
   ============================================================ */
function setSending(v) {
  state.sending = v;
  $("send-btn").disabled = v;
}

async function sendQuestion() {
  const input = $("composer-input");
  const question = input.value.trim();
  if (!question) { toast("请输入问题", true); return; }
  const profile = currentProfileOf();
  const isAgent = Boolean(profile && profile.engine_kind !== "qa_graph");
  if (isAgent) {
    // runtime 引擎（harness 移植）：运行中点发送 = 中断当前 turn；发送走 harness /api/turn
    if (state.hwBusy) { void cancelAgentTurn(); return; }
    if (!state.currentSessionId) await newSession();
    input.value = "";
    await sendAgentTurn(question);
    return;
  }
  if (!state.currentSessionId) {
    try {
      const s = await api("/workbench/sessions", {
        method: "POST",
        body: JSON.stringify({ profile_key: state.profileKey, title: question.slice(0, 20) }),
      });
      state.sessions.unshift(s);
      state.currentSessionId = s.id;
      state.currentProfile = profileOf(s.profile_key);
      applyProfileChrome();
      renderSessions();
      startSessionStream(s.id);
    } catch (err) { toast(errText(err), true); return; }
  }
  if (state.sending) return;
  setSending(true);
  input.value = "";

  const inner = $("chat-inner");
  inner.querySelector(".chat-empty") && inner.querySelector(".chat-empty").remove();

  // qa_graph 引擎：SSE 直播（text/delta/done/error 帧协议与原 /chat 一致）
  const qEl = appendQuestion(inner, question); // 乐观气泡；user 帧到达后以落库文本（脱敏）替换
  const block = buildAnswerBlock(inner, null);
  const body = block.querySelector(".a-body");
  body.classList.add("thinking"); // 首 delta 前保留「正在检索…」占位（CSS 点点动画）
  scrollBottom();

  // 打字机：delta 只累积目标文本，渲染按固定速率追平——模型快吐也不瞬间满屏；
  // done 后提速收尾（长回答不拖尾），错误/断流立即终止打字
  let answer = "";
  let shown = 0;
  let typeChars = 4; // 每 tick 追平字符数（≈240 字/秒）
  let donePending = null;
  let p = null;
  const ensureParagraph = () => {
    if (!p) {
      body.classList.remove("thinking");
      body.innerHTML = "";
      p = document.createElement("p");
      body.appendChild(p);
    }
    return p;
  };
  const typer = setInterval(() => {
    if (shown >= answer.length) {
      if (donePending) {
        clearInterval(typer);
        const fn = donePending;
        donePending = null;
        fn();
      }
      return;
    }
    shown = Math.min(answer.length, shown + typeChars);
    const el = ensureParagraph();
    el.textContent = answer.slice(0, shown);
    el.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
    scrollBottom();
  }, 16);
  const stopTyping = () => { clearInterval(typer); donePending = null; };

  state.pendingQuestion = question; // 会话流重放本条 user 帧时去重
  state.qaAnswer = "";

  const finish = (runId, citations, failed) => {
    stopTyping();
    const el = ensureParagraph();
    el.textContent = answer;
    if (!answer) body.innerHTML = `<p class="empty-hint">${esc(failed || "未产生回答")}</p>`;
    fillGov(block.querySelector(".gov-strip"), runId);
    block.querySelector(".meta").textContent = runId ? "Run " + runId.slice(0, 8) : "";
    setSending(false);
    scrollBottom();
    loadSessions(); // 刷新会话列表顺序
  };

  try {
    const res = await fetch(`/api/workbench/sessions/${state.currentSessionId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ question, model: state.qaModel || null }),
    });
    if (res.status === 401) { stopTyping(); logout(); return; }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* noop */ }
      stopTyping();
      body.classList.add("err");
      ensureParagraph().textContent = `提问失败：${res.status} ${detail}`;
      state.pendingQuestion = null;
      setSending(false);
      return;
    }
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("text/event-stream")) { // 防御：非流式响应按任务受理处理
      stopTyping();
      await res.json().catch(() => ({}));
      toast("已受理为任务，进度将在会话流中呈现");
      state.pendingQuestion = null;
      setSending(false);
      loadSessions();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const parseFrame = (raw) => {
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) return null;
      try { return { event, payload: JSON.parse(data) }; } catch { return null; }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = parseFrame(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (!frame) continue;
        if (frame.event === "text") {
          const env = frame.payload;
          const d = (env && env.data) || {};
          if (env && env.seq !== undefined) state.renderedSeqs.add(env.seq);
          if (d.role === "user" && state.pendingQuestion !== null) {
            // 以落库文本为准（含输入脱敏）：替换乐观气泡，敏感原文不驻留聊天流
            qEl.querySelector(".txt").textContent = d.text;
            state.pendingQuestion = null;
          }
        } else if (frame.event === "delta") {
          answer += frame.payload.text;
          state.qaAnswer = answer; // DOM 更新交给打字机节流
        } else if (frame.event === "done") {
          // assistant 信封 seq：会话流重放该帧时按已渲染去重
          state.qaDoneSeq = frame.payload.seq || 0;
          typeChars = 24; // 收尾提速：长回答不拖尾
          const fn = () => finish(frame.payload.run_id, frame.payload.citations, null);
          if (shown >= answer.length) fn();
          else donePending = fn;
        } else if (frame.event === "error") {
          if (frame.payload.user_seq) state.renderedSeqs.add(frame.payload.user_seq);
          state.pendingQuestion = null;
          body.classList.add("err");
          finish(frame.payload.run_id || null, null, frame.payload.message);
        }
      }
    }
    if (state.sending) finish(null, null, "连接中断");
  } catch (err) {
    stopTyping();
    body.classList.add("err");
    ensureParagraph().textContent = `连接异常：${errText(err)}`;
    state.pendingQuestion = null;
    setSending(false);
  }
}

/* ============================================================
   统一工作台（ADR-014~017 一期）：Profile 选择 · 消息信封渲染 · 会话流
   ============================================================ */

function profileOf(key) {
  return state.profiles.find((p) => p.key === (key || "knowledge-assistant")) || null;
}

function agentName() {
  const p = currentProfileOf();
  return p ? p.display_name : "知识问答助手";
}

function currentProfileOf() {
  // 会话优先：刷新回放时 profiles 可能晚于 openSession 到达，统一按会话绑定解析
  if (state.currentSessionId) {
    const s = state.sessions.find((x) => x.id === state.currentSessionId);
    return s ? profileOf(s.profile_key) : state.currentProfile;
  }
  return profileOf(state.profileKey);
}

async function loadProfiles() {
  if (!state.token) return;
  try {
    state.profiles = await api("/workbench/profiles");
    renderSessions(); // 会话列表的智能体标记依赖 profiles
    applyProfileChrome();
  } catch (err) {
    toast(errText(err), true);
  }
}

function applyProfileChrome() {
  const p = currentProfileOf();
  const isAgent = Boolean(p && p.engine_kind !== "qa_graph");
  const chip = $("agent-chip");
  if (chip) chip.textContent = isAgent ? `🤖 ${p.display_name}` : "💬 智能问答";
  const empty = document.querySelector("#chat-inner .chat-empty");
  if (empty) {
    empty.querySelector(".t").textContent = isAgent ? `向${p.display_name}下达任务` : "向知识助手提问";
    empty.querySelector(".s").textContent = isAgent
      ? "任务交由 Agent 执行：计划、工具卡片与审批都在本聊天流中完成"
      : "回答基于你有权访问的知识库生成；右上角可切换智能体与模型";
  }
  $("composer-input").placeholder = isAgent ? `向${p.display_name}下达任务…（Enter 发送）` : "向知识助手提问…（Enter 发送）";
  updateComposerMode();
  updateModelChip();
}

// ---------- 消息信封渲染（回放与直播共用，全部幂等） ----------

function renderEnvelope(m) {
  if (m.seq !== undefined && state.renderedSeqs.has(m.seq)) return null;
  if (m.seq !== undefined) {
    state.renderedSeqs.add(m.seq);
    if (m.seq > state.seenSeq) state.seenSeq = m.seq;
  }
  const d = m.data || {};
  const inner = $("chat-inner");
  inner.querySelector(".chat-empty") && inner.querySelector(".chat-empty").remove();
  if (m.type === "text") {
    if (d.role === "user") { appendQuestion(inner, d.text || ""); return null; }
    return renderAssistantEnvelope(d);
  }
  return null;
}

function renderAssistantEnvelope(d) {
  const block = buildAnswerBlock($("chat-inner"), null);
  const body = block.querySelector(".a-body");
  const p = document.createElement("p");
  p.textContent = d.text || "";
  body.innerHTML = "";
  body.appendChild(p);
  fillGov(block.querySelector(".gov-strip"), null);
  scrollBottom();
  return block;
}

// ---------- 会话流：fetch SSE + Last-Event-ID 续传（无终态帧，断线自动重连） ----------

function setStreamState(text, on) {
  const el = $("stream-state");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("on", !!on);
}

async function startSessionStream(sessionId) {
  state.streamEpoch += 1;
  const epoch = state.streamEpoch;
  state.streamAbort = new AbortController();
  try {
    const res = await fetch(`/api/workbench/sessions/${sessionId}/stream`, {
      headers: {
        Authorization: "Bearer " + state.token,
        Accept: "text/event-stream",
        ...(state.seenSeq > 0 ? { "Last-Event-ID": String(state.seenSeq) } : {}),
      },
      signal: state.streamAbort.signal,
    });
    if (!res.ok) {
      if (res.status === 401) { logout(); return; }
      setStreamState("SSE 未连接", false);
      return;
    }
    setStreamState("SSE 已连接", true);
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
        if (epoch !== state.streamEpoch) return; // 已切换会话：丢弃旧流帧
        onStreamFrame(frame);
      }
    }
  } catch (err) {
    if (err.name === "AbortError") return; // 主动切换会话/登出
  }
  // 会话流无终态帧（客户端断开收尾）：2s 后按 Last-Event-ID 续传
  if (epoch === state.streamEpoch && state.token && $("view-app").classList.contains("active")) {
    setStreamState("SSE 重连中…", false);
    setTimeout(() => {
      if (epoch === state.streamEpoch && state.token) startSessionStream(sessionId);
    }, 2000);
  }
}

function onStreamFrame(frame) {
  let seq = null, type = "", payload = {};
  for (const line of frame.split("\n")) {
    if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
    else if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      try { payload = JSON.parse(line.slice(5).trim()); } catch { payload = {}; }
    }
  }
  if (!type) return;
  const m = {
    seq: payload.seq !== undefined ? payload.seq : seq,
    type,
    data: payload.data || {},
  };
  // POST SSE 直播期间 user 帧由 POST 流通道渲染（乐观气泡 + 落库文本替换）；
  // 落库文本可能已脱敏，与乐观原文不再相等，文本匹配去重不可靠 → sending 期间仅记账
  if (m.type === "text" && m.data.role === "user" && state.sending) {
    // 仅记账（帧尾统一 renderedSeqs），渲染归 POST 流通道
  } else if (m.type === "text" && m.data.role === "assistant"
    && (m.seq <= state.qaDoneSeq
      || (state.sending && typeof state.qaAnswer === "string" && m.data.text === state.qaAnswer))) {
    state.qaDoneSeq = Math.max(state.qaDoneSeq, m.seq || 0); // 同上
  } else {
    renderEnvelope(m);
    scrollBottom();
  }
  if (m.seq !== undefined && !state.renderedSeqs.has(m.seq)) {
    state.renderedSeqs.add(m.seq);
    if (m.seq > state.seenSeq) state.seenSeq = m.seq;
  }
}

/* ============================================================
   Agent 内嵌（harness 渲染体系移植，ADR-019 后续）：
   发送 → POST /api/harness/api/turn；事件经全局 SSE（/api/harness/api/events）按 traceId
   过滤渲染到当前 Agent 会话（traceId ↔ platform 会话映射持久化于 zs_hw_traces）。
   渲染器与类名沿用 harness（.turn/.msg/.plan-card/.wave/.tool-card/.perm-card），样式已移植本页；
   markdown 渲染复用 harness/markdown.js（index.html module 桥挂 window.renderMarkdown）。
   ============================================================ */

const OUTPUT_PREVIEW_CHARS = 200;

const REASON_LABELS = {
  goal_completed: "完成",
  max_iterations_reached: "达到迭代上限",
  needs_user_decision: "需要用户决策",
  guardrail_rejected: "护栏拒绝",
  user_interrupted: "已中断",
  error: "出错",
};

// ---------- 小工具（harness 同名移植） ----------

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

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Thinking 模型可能吐 <think> 块，聊天区不展示。 */
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

/** markdown 渲染：优先 module 桥的全量转义渲染器，降级纯文本转义 */
function renderMd(text) {
  return typeof window.renderMarkdown === "function" ? window.renderMarkdown(text) : esc(text);
}

function scrollIfNearBottom() {
  const sc = $("chat-scroll");
  if (!sc) return;
  const gap = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  if (gap < 140) sc.scrollTop = sc.scrollHeight;
}

// ---------- 会话渲染状态（平台单会话容器 = 单 hwSession） ----------

let hwSession = null;

function resetHwSession() {
  // 对齐 harness 原版语义（restoreTranscript）：replay 每次连接重推，重建前必须清空，
  // 否则重连（如每次 sendAgentTurn 的幂等重连）会把已渲染的 turn 重复画一遍。
  // 其余调用点（openSession/sendAgentTurn 容器重建分支）本就是空容器，清空为无害 no-op。
  const stream = $("hw-stream");
  if (stream) stream.replaceChildren();
  hwSession = {
    stream: $("hw-stream"),
    turnGroup: null,
    plan: null,
    waves: new Map(),
    cards: new Map(),
    live: null,
  };
}

/** 事件归属：已知 trace 按映射路由（跨会话串流防护）；未知/无 trace 事件仅跟随当前会话发起的运行中 turn */
function hwSessionForTrace(traceId) {
  if (!hwSession) return null;
  const isLive = state.hwBusy && state.hwActiveSession === state.currentSessionId;
  if (traceId) {
    for (const [sid, set] of state.hwTraceIds) {
      if (set.has(traceId)) return sid === state.currentSessionId ? hwSession : null;
    }
    return isLive ? hwSession : null; // 竞态：traceId 尚未登记（POST 响应未返回）但事件已到
  }
  return isLive ? hwSession : null; // user_message 等不带 traceId 的事件
}

function hwSessionForEvent(payload) {
  return hwSessionForTrace(payload && payload.traceId);
}

// ---------- turn 组与消息渲染（harness 移植） ----------

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
  session.live.content.innerHTML = renderMd(stripThink(session.live.raw));
  scrollIfNearBottom();
}

function onAssistantMessage(session, text) {
  if (!session) return;
  const visible = stripThink(text);
  if (visible) {
    const bubble = session.live ?? addAgentBubble(session);
    bubble.content.innerHTML = renderMd(visible);
    session.live = null;
  } else if (session.live) {
    session.live.wrap.remove();
    session.live = null;
  }
  scrollIfNearBottom();
}

// ---------- 计划卡（源自 runtime 真实 wave 调度） ----------

function setStep(step, stepState) {
  step.state = stepState;
  step.row.className = `plan-step ${stepState}`;
  step.check.className = `step-check ${stepState}`;
  step.check.textContent = stepState === "done" ? "✓" : stepState === "running" ? "…" : "•";
}

function addPlanStep(plan, text) {
  const row = el("div", "plan-step");
  const check = el("div", "step-check todo", "•");
  const label = el("div", "step-text", text);
  const count = el("div", "step-count", "");
  row.append(check, label, count);
  plan.list.append(row);
  const step = { row, check, label, count, state: "todo" };
  plan.steps.push(step); // 登记：finishPlan 依此收尾 running 步骤
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

// ---------- Wave 与工具卡 ----------

function waveGroup(session, wave, parallel) {
  const existing = session.waves.get(wave);
  if (existing) return existing;

  const group = ensureTurn(session);
  const plan = ensurePlan(session);
  if (plan.reasoning && plan.reasoning.state === "running") setStep(plan.reasoning, "done");

  // 默认折叠：一条安静的摘要行；点击展开工具卡片
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

/** 折叠摘要行保持最新：进度 → 结果（+ 耗时） */
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

// ---------- turn 生命周期 ----------

function onTurnFinished(payload, session) {
  const s = session ?? hwSessionForEvent(payload);
  if (s && s.turnGroup) {
    const footer = el("div", "turn-footer");
    footer.append(
      el("b", null, REASON_LABELS[payload.reason] ?? payload.reason ?? "结束"),
      el("span", null, `${payload.iterations ?? 0} iterations`),
      el("span", null, formatDuration(payload.durationMs)),
    );
    if (payload.reason === "error" && payload.text) {
      footer.append(el("span", null, oneLine(payload.text, 100)));
    }
    s.turnGroup.append(footer);
    finishPlan(s);
    s.turnGroup = null;
    s.plan = null;
    s.waves = new Map();
    s.cards = new Map();
    s.live = null;
  }
  state.hwBusy = false;
  updateComposerMode();
  scrollIfNearBottom();
}

// ---------- SSE 事件入口 ----------

function onHwSessionEvent(event) {
  if (!event || typeof event.type !== "string") return;
  const session = hwSessionForEvent(event);
  if (!session) return;
  switch (event.type) {
    case "user_message":
      // 用户气泡由服务端事件渲染（回放安全），sendAgentTurn 不本地画
      addUserMessage(session, event.text ?? "");
      break;
    case "turn_started": {
      const group = ensureTurn(session);
      const marker = el("div", "turn-marker", `TURN · trace ${String(event.traceId || "").slice(0, 8)}`);
      group.prepend(marker);
      break;
    }
    case "phase_changed":
      break; // 平台版无 Turn 状态机面板
    case "message_appended": {
      if (!event.message || event.message.role !== "assistant") break;
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
      break;
    default:
      break;
  }
}

/**
 * 从服务端 transcript 重建聊天流（SSE "replay"，每次连接重推）：
 * entries 是全部 trace 的事件流，而 user_message 等事件不带 traceId——
 * 用 turn_started.traceId 作游标：仅渲染属于当前会话（traceId ∈ 映射集合）的 turn 区段。
 */
function restoreHwTranscript(entries) {
  if (!hwSession) return;
  resetHwSession();
  const set = state.hwTraceIds.get(state.currentSessionId);
  if (!set) {
    // 映射丢失（跨浏览器/清存储）：历史不可回放，仅提示，不阻塞新对话
    addErrorNote(hwSession, "该会话的历史在本浏览器没有回放索引（traceId 映射丢失），不影响继续对话");
    return;
  }
  let gate = false; // 游标：turn 结束后关闭，等待下一个 turn_started 重新判定归属
  for (const entry of entries) {
    if (!entry || typeof entry.kind !== "string") continue;
    if (entry.kind === "session") {
      const ev = entry.payload || {};
      if (ev.type === "turn_started") {
        gate = Boolean(ev.traceId && set.has(ev.traceId));
        if (gate) onHwSessionEvent(ev);
        continue;
      }
      if (gate) onHwSessionEvent(ev);
    } else if (gate) {
      if (entry.kind === "tool_input") setToolInput(hwSession, entry.payload?.callId, entry.payload?.input ?? "");
      else if (entry.kind === "tool_result") setToolOutput(hwSession, entry.payload);
      else if (entry.kind === "turn") { onTurnFinished(entry.payload, hwSession); gate = false; }
    }
  }
  scrollBottom();
}

// ---------- harness events SSE（fetch 流式 + 指数退避重连，epoch 保护） ----------

function startHwStream() {
  state.hwEpoch += 1;
  const epoch = state.hwEpoch;
  if (state.hwAbort) state.hwAbort.abort();
  const controller = new AbortController();
  state.hwAbort = controller;
  setStreamState("Agent 流连接中…", false);
  void (async () => {
    let attempts = 0;
    while (epoch === state.hwEpoch && state.token) {
      try {
        const res = await fetch("/api/harness/api/events", {
          headers: { Accept: "text/event-stream", Authorization: "Bearer " + state.token },
          signal: controller.signal,
        });
        if (res.status === 401) { logout(); return; }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempts = 0;
        setStreamState("Agent 流已连接", true);
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
            if (epoch !== state.hwEpoch) return; // 已切换会话/登出：丢弃旧流帧
            dispatchHwFrame(frame);
          }
        }
      } catch (err) {
        if (err.name === "AbortError") return; // 主动切换会话/登出
      }
      if (epoch !== state.hwEpoch || !state.token) return;
      attempts += 1;
      if (attempts > 5) { setStreamState("Agent 流断开", false); return; }
      setStreamState("Agent 流重连中…", false);
      await new Promise((resolve) => setTimeout(resolve, Math.min(8000, 500 * 2 ** attempts)));
    }
  })();
}

// 原生 EventSource addEventListener 的等价分发表（fetch 流式无事件名 API）
const HW_SSE_HANDLERS = {
  replay: (payload) => {
    if (Array.isArray(payload) && payload.length) restoreHwTranscript(payload);
  },
  state: (payload) => {
    if (payload) applyHwState(payload);
  },
  session: (payload) => {
    if (payload) onHwSessionEvent(payload);
  },
  delta: (payload) => {
    const session = hwSessionForEvent(payload);
    if (payload && session) onDelta(session, payload.text ?? "");
  },
  tool_input: (payload) => {
    const session = hwSessionForEvent(payload);
    if (payload && session) setToolInput(session, payload.callId, payload.input ?? "");
  },
  tool_result: (payload) => {
    const session = hwSessionForEvent(payload);
    if (payload && session) setToolOutput(session, payload);
  },
  approval: () => { /* 审批卡片随 state 快照渲染 */ },
  approval_resolved: () => { /* 同上 */ },
  turn: (payload) => {
    if (payload) onTurnFinished(payload);
  },
  compaction: () => { /* 平台版无压缩提示面板 */ },
};

function dispatchHwFrame(frame) {
  let name = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue; // 心跳/注释行
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  const handler = HW_SSE_HANDLERS[name];
  if (!handler) return;
  const raw = dataLines.join("\n");
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }
  handler(payload);
}

/** harness 派生快照：仅取平台版关心的字段（忙碌/模型/审批） */
function applyHwState(snapshot) {
  if (!hwSession) return; // 非 Agent 会话不消费 harness 状态
  state.hwBusy = Boolean(snapshot.busy);
  if (snapshot.health && snapshot.health.model) {
    state.hwModel = snapshot.health.model;
    updateModelChip();
  }
  renderHwApprovals(snapshot.approvals);
  updateComposerMode();
}

// ---------- 审批卡片（渲染于聊天流下方常驻区，POST /api/harness/api/approve） ----------

function renderHwApprovals(approvals) {
  const box = $("hw-approvals");
  if (!box) return;
  box.replaceChildren();
  const list = approvals ?? [];
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
    allow.addEventListener("click", () => void hwDecide(approval.requestId, "allowed", buttons));
    always.addEventListener("click", () => void hwDecide(approval.requestId, "always", buttons));
    deny.addEventListener("click", () => void hwDecide(approval.requestId, "denied", buttons));
    buttons.append(allow, always, deny);
    card.append(buttons);
    box.append(card);
  }
}

async function hwDecide(requestId, decision, buttons) {
  for (const btn of buttons.querySelectorAll("button")) btn.disabled = true;
  try {
    const res = await hwFetch("/api/approve", {
      method: "POST",
      body: JSON.stringify({ requestId, decision }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      toast((payload && payload.error && payload.error.message) || `审批失败（HTTP ${res.status}）`, true);
    }
  } catch {
    toast("审批请求发送失败", true);
  }
}

// ---------- 发送与中断（POST /api/harness/api/turn · /api/cancel） ----------

async function sendAgentTurn(text) {
  // 容器保障：newSession 后未经 openSession 直接发送时补建（含移除空态占位）
  if (!$("hw-stream")) {
    $("chat-inner").innerHTML = '<div class="chat-stream" id="hw-stream"></div><div class="hw-approvals" id="hw-approvals"></div>';
  }
  if (!hwSession || hwSession.stream !== $("hw-stream")) resetHwSession();
  startHwStream(); // 事件流保障：newSession 直发路径无人启动过全局 SSE（已连接则幂等重连，replay 重建渲染）
  state.hwActiveSession = state.currentSessionId;
  state.hwBusy = true;
  updateComposerMode();
  scrollIfNearBottom();
  try {
    const res = await hwFetch("/api/turn", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = (payload && payload.error && payload.error.message) || `发送失败（HTTP ${res.status}）`;
      addErrorNote(hwSession, message);
      toast(message, true);
      state.hwBusy = false;
      updateComposerMode();
      return;
    }
    // 绑定本 turn 与 platform 会话：replay 与 live 事件都按 traceId 归属
    if (payload && payload.traceId) {
      const set = state.hwTraceIds.get(state.currentSessionId) || new Set();
      set.add(payload.traceId);
      state.hwTraceIds.set(state.currentSessionId, set);
      persistHwTraces();
    } else {
      // 静默吞掉会让“刷新后回放失效”变成无头案：至少留一条可查的痕迹
      console.warn("[hw-turn] 响应无 traceId，未注册：", JSON.stringify(payload).slice(0, 120));
    }
  } catch {
    addErrorNote(hwSession, "无法连接 Agent runtime");
    toast("无法连接 Agent runtime", true);
    state.hwBusy = false;
    updateComposerMode();
  }
}

async function cancelAgentTurn() {
  try {
    const res = await hwFetch("/api/cancel", { method: "POST", body: "{}" });
    const payload = await res.json().catch(() => ({}));
    if (res.status === 501) {
      toast("当前 runtime 尚未提供中断能力，turn 会继续执行", true);
      return;
    }
    if (!res.ok) {
      toast((payload && payload.error && payload.error.message) || `中断失败（HTTP ${res.status}）`, true);
      return;
    }
    toast(payload.cancelled ? "已请求中断" : "当前没有运行中的 turn");
  } catch {
    toast("中断请求发送失败", true);
  }
}

// ---------- chip 与发送按钮模式 ----------

function updateModelChip() {
  const chip = $("model-chip");
  if (!chip) return;
  const p = currentProfileOf();
  if (p && p.engine_kind !== "qa_graph") {
    chip.textContent = state.hwModel ? `模型：${state.hwModel}` : "模型：—";
  } else {
    chip.textContent = state.qaModel ? `模型：${state.qaModel}` : "模型：平台默认";
  }
}

function updateComposerMode() {
  const btn = $("send-btn");
  if (!btn) return;
  const p = currentProfileOf();
  const isAgent = Boolean(p && p.engine_kind !== "qa_graph");
  if (isAgent && state.hwBusy) {
    btn.disabled = false;
    btn.textContent = "■ 中断";
    btn.title = "中断当前 turn";
  } else {
    btn.textContent = "发 送";
    btn.title = "发送（Enter）";
    btn.disabled = state.sending;
  }
}

// ---------- 模型选择器（移植 harness toggleModelPicker/switchModel/custom 管理） ----------
// 数据源：GET /api/harness/api/models（+ state 快照 health）；
// 切换按模式路由：问答模式记录到 localStorage 并随 send_message 透传（后端链首覆盖，fallback 链保留）；
// Agent 模式 POST /api/harness/api/model（runtime 热切换，对话保留）。

let modelPicker = null;
let modelPickerCloser = null;

function closeModelPicker(clickEvent) {
  if (modelPicker && clickEvent && modelPicker.contains(clickEvent.target)) return;
  if (modelPicker) modelPicker.remove();
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
    const res = await hwFetch("/api/models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    toast(`获取模型列表失败：${errText(err)}`, true);
    return;
  }

  const p = currentProfileOf();
  const isAgent = Boolean(p && p.engine_kind !== "qa_graph");
  const currentName = isAgent ? (data.current || state.hwModel) : (state.qaModel || "");

  const panel = el("div", "model-picker");
  panel.append(el("div", "model-picker-title", isAgent ? "选择模型（Agent runtime）" : "选择模型（智能问答）"));
  const FORMAT_LABELS = { "chat-completions": "Chat", "anthropic-messages": "Anthropic", "responses": "Responses" };
  for (const m of data.models ?? []) {
    const item = el("div", `model-item${m.model === currentName ? " current" : ""}`);
    const main = el("button", "model-item-main");
    main.type = "button";
    main.append(el("span", "model-name", m.model));
    const metaParts = [m.provider, m.custom ? `线上 · ${FORMAT_LABELS[m.apiFormat] ?? "Chat"}` : (m.declared ? "" : "自动发现")].filter(Boolean);
    main.append(el("span", "model-meta", metaParts.join(" · ")));
    if (m.model === currentName) main.disabled = true;
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
  const chip = $("model-chip");
  const rect = chip.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  modelPicker = panel;
  modelPickerCloser = closeModelPicker;
  setTimeout(() => document.addEventListener("click", modelPickerCloser), 0);
}

async function switchModel(name) {
  closeModelPicker();
  const p = currentProfileOf();
  if (!p || p.engine_kind === "qa_graph") {
    // 问答模式：会话级覆盖——localStorage 记忆 + send_message 透传（随下一次提问生效）
    state.qaModel = name;
    localStorage.setItem("zs_qa_model", name);
    updateModelChip();
    toast(`问答模型已切换：${name}`);
    return;
  }
  toast(`切换模型到 ${name} …`);
  try {
    const res = await hwFetch("/api/model", {
      method: "POST",
      body: JSON.stringify({ model: name }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
    state.hwModel = body.model || name;
    updateModelChip();
    toast(`✓ 已切换到 ${state.hwModel}（对话已保留）`);
    // 服务端随后经 SSE 推送新的 state 快照，chip 会自动校准
  } catch (err) {
    toast(`切换失败：${errText(err)}`, true);
  }
}

/** 「添加线上模型」表单；editEntry 非空时进入编辑模式（apiKey 留空保持原 Key） */
function buildCustomModelForm(editEntry = null) {
  const isEdit = Boolean(editEntry && editEntry.isEdit);
  const wrap = el("div", "mp-custom");
  const addBtn = el("button", "mp-custom-toggle", isEdit ? `✎ 编辑「${editEntry.provider}」` : "➕ 添加线上模型");
  addBtn.type = "button";
  addBtn.title = isEdit
    ? `正在编辑线上模型 ${editEntry.provider}（API Key 留空则保持不变）`
    : "添加线上模型（自定义 URL / API Key / API 格式 / 模型 ID / 上下文长度）";
  const form = el("div", "mp-custom-form");
  form.hidden = !isEdit; // 新增默认折叠；编辑模式保持展开
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

  const e = editEntry || {};
  const name = field("名称", "如 deepseek（留空则用模型 ID）", { optional: true, value: isEdit ? e.provider : "" });
  const url = field("Base URL", "https://api.deepseek.com（或含 /v1）", { value: isEdit ? e.baseUrl : "" });
  const key = field("API Key", isEdit ? "留空保持原 Key 不变" : "sk-…（本地代理可留空）", { optional: true, secret: true });
  const model = field("模型 ID", "如 deepseek-chat", { value: isEdit ? e.model : "" });
  const ctx = field("上下文长度", "tokens，如 65536（留空默认 32768）", { optional: true, value: isEdit && e.contextWindow ? String(e.contextWindow) : "" });

  // 三种 API wire format，同一 OpenAI 兼容 Base URL 字段
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
    submit.textContent = "保存中…";
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
      const res = await hwFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
      toast(isEdit ? `✓ 已修改 ${body.model}（provider: ${body.provider}）` : `✓ 已添加 ${body.model}，点击列表即可切换`);
      closeModelPicker();
      void toggleModelPicker(); // 重开以展示最新列表
    } catch (err) {
      errLine.textContent = errText(err);
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
  // 表单 hidden 定型后同步初始箭头
  addBtn.textContent = `${toggleIcon()} ${form.hidden ? (isEdit ? `编辑「${e.provider}」` : "添加线上模型") : "收起表单"}`;

  wrap.append(addBtn, form);
  return wrap;
}

/** 按 provider 删除线上模型，然后刷新已打开的选择器 */
async function removeCustomModel(provider) {
  if (!confirm(`删除线上模型「${provider}」？\n\n仅移除本工具中的接入配置，不影响服务商账号。`)) return;
  try {
    const res = await hwFetch("/api/models/custom/remove", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body && body.error && body.error.message) || `HTTP ${res.status}`);
    toast(`✓ 已删除 ${provider}`);
    closeModelPicker();
    void toggleModelPicker();
  } catch (err) {
    toast(`删除失败：${errText(err)}`, true);
  }
}

// ---------- 智能体选择器（agent chip：列出 profiles；选择 = 开新会话，Q3A 语义不变） ----------

let agentPicker = null;
let agentPickerCloser = null;

function closeAgentPicker(clickEvent) {
  if (agentPicker && clickEvent && agentPicker.contains(clickEvent.target)) return;
  if (agentPicker) agentPicker.remove();
  agentPicker = null;
  if (agentPickerCloser) document.removeEventListener("click", agentPickerCloser);
  agentPickerCloser = null;
}

function toggleAgentPicker() {
  if (agentPicker) {
    closeAgentPicker();
    return;
  }
  const panel = el("div", "model-picker");
  panel.append(el("div", "model-picker-title", "选择智能体"));
  const cur = currentProfileOf();
  const currentKey = (cur || profileOf(state.profileKey) || {}).key || "knowledge-assistant";
  for (const p of state.profiles) {
    const isAgent = p.engine_kind !== "qa_graph";
    const active = p.key === currentKey;
    const item = el("div", `model-item${active ? " current" : ""}`);
    const main = el("button", "model-item-main");
    main.type = "button";
    main.append(el("span", "model-name", isAgent ? `🤖 ${p.display_name}` : "💬 智能问答"));
    main.append(el("span", "model-meta", p.description || (isAgent ? "Agent 任务执行" : "知识库问答（默认）")));
    if (active) main.disabled = true; // 当前会话已绑定该智能体
    main.addEventListener("click", () => {
      closeAgentPicker();
      if (active) return;
      state.profileKey = p.key; // 新会话绑定所选智能体
      void newSession();
    });
    item.append(main);
    panel.append(item);
  }
  document.body.append(panel);
  const chip = $("agent-chip");
  const rect = chip.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 6}px`;
  panel.style.left = `${Math.max(8, rect.left)}px`;
  agentPicker = panel;
  agentPickerCloser = closeAgentPicker;
  setTimeout(() => document.addEventListener("click", agentPickerCloser), 0);
}

/* ============================================================
   知识库页
   ============================================================ */
const JOB_STATE = {
  queued: ["js-queued", "排队中"],
  running: ["js-running", "运行中"],
  succeeded: ["js-done", "成功"],
  failed: ["js-fail", "失败"],
  dead: ["js-fail", "失败（重试耗尽）"],
};

async function loadKbPage() {
  try {
    state.kbs = await api("/admin/kbs");
    const acls = await Promise.all(
      state.kbs.map((kb) => api(`/admin/kbs/${kb.id}/acls`).catch(() => []))
    );
    const aclCount = new Map(state.kbs.map((kb, i) => [kb.id, acls[i].length]));

    const sel = $("upload-kb-select");
    sel.innerHTML = state.kbs
      .map((kb) => `<option value="${kb.id}">${esc(kb.name)}（${sealOf(kb.classification)[1]}）</option>`)
      .join("");

    $("kb-list-body").innerHTML = state.kbs.length
      ? state.kbs
          .map((kb) => {
            const [sealCls, sealText] = sealOf(kb.classification);
            return `<tr>
              <td>${esc(kb.name)}</td>
              <td><span class="doc-seal-inline ${sealCls}">${sealText}</span></td>
              <td class="dim">${esc(kb.description || "—")}</td>
              <td>${aclCount.get(kb.id) || 0} 个角色</td>
              <td>${esc(kb.index_version || "v1")}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="5" class="dim">暂无知识库，请在下方创建</td></tr>';

    await loadKbTasks();
  } catch (err) {
    toast(errText(err), true);
  }
}

async function loadKbTasks() {
  if (!state.kbs.length) {
    $("kb-jobs-body").innerHTML = '<tr><td colspan="6" class="dim">暂无入库任务</td></tr>';
    return;
  }
  try {
    const perKb = await Promise.all(
      state.kbs.map(async (kb) => {
        const tasks = await api(`/admin/kbs/${kb.id}/tasks`).catch(() => []);
        return tasks.map((t) => ({ ...t, kbName: kb.name, kbClassification: kb.classification }));
      })
    );
    const tasks = perKb.flat().sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    const hasPending = tasks.some((t) => t.status === "queued" || t.status === "running");
    // 数据未变不重建：轮询周期内用户可能正在点击展开切片，重建会让节点失效
    const tasksKey = JSON.stringify(tasks);
    if (tasksKey === state.lastTasksKey) return hasPending;
    state.lastTasksKey = tasksKey;
    $("kb-jobs-body").innerHTML = tasks.length
      ? tasks
          .map((t) => {
            const [cls, label] = JOB_STATE[t.status] || ["js-queued", t.status];
            const detail = t.status === "failed" && t.last_error ? " · " + esc(t.last_error).slice(0, 40) : "";
            const [sealCls, sealText] = sealOf(t.kbClassification);
            const time = t.created_at ? t.created_at.slice(5, 16).replace("T", " ") : "";
            const clickable = t.status === "succeeded";
            const open = state.chunksOpen.has(t.id);
            return `<tr${clickable ? ' class="clickable chunks-toggle" title="点击查看切片结果"' : ""} data-tid="${t.id}" data-kb="${t.kb_id}">
              <td>${esc(t.source_filename)}${clickable ? `<span class="chunk-arrow">${open ? "▾" : "▸"}</span>` : ""}</td>
              <td>${esc(t.kbName)}</td>
              <td><span class="doc-seal-inline ${sealCls}">${sealText}</span></td>
              <td><span class="job-state ${cls}">${label}${detail}</span></td>
              <td>${t.attempt}/${t.max_attempts}</td>
              <td class="dim">${time}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="6" class="dim">暂无入库任务</td></tr>';
    const tbody = $("kb-jobs-body");
    tbody.querySelectorAll("tr.chunks-toggle").forEach((tr) => {
      tr.addEventListener("click", () => toggleChunks(tr.dataset.tid, tr));
    });
    // 轮询重渲染后重建已展开的切片预览行
    for (const tid of state.chunksOpen) {
      const tr = tbody.querySelector(`tr[data-tid="${tid}"]`);
      if (tr) insertChunkRow(tid, tr);
    }
    return hasPending;
  } catch {
    return false;
  }
}

async function toggleChunks(taskId, tr) {
  if (state.chunksOpen.has(taskId)) {
    state.chunksOpen.delete(taskId);
    const row = document.querySelector(`tr[data-chrow="${taskId}"]`);
    if (row) row.remove();
    const arrow = tr.querySelector(".chunk-arrow");
    if (arrow) arrow.textContent = "▸";
    return;
  }
  if (!state.chunksCache.has(taskId)) {
    try {
      state.chunksCache.set(taskId, await api(`/admin/kbs/${tr.dataset.kb}/tasks/${taskId}/chunks?limit=500`));
    } catch (err) {
      toast(errText(err), true);
      return;
    }
  }
  state.chunksOpen.add(taskId);
  insertChunkRow(taskId, tr);
  const arrow = tr.querySelector(".chunk-arrow");
  if (arrow) arrow.textContent = "▾";
}

function insertChunkRow(taskId, tr) {
  const data = state.chunksCache.get(taskId);
  if (!data) return;
  const old = document.querySelector(`tr[data-chrow="${taskId}"]`);
  if (old) old.remove();
  const row = document.createElement("tr");
  row.className = "chunk-detail-row";
  row.dataset.chrow = taskId;
  row.innerHTML = `<td colspan="6">${renderChunkPreview(data)}</td>`;
  row.addEventListener("click", (e) => e.stopPropagation());
  tr.after(row);
}

function renderChunkPreview(data) {
  const statusLabel = (JOB_STATE[data.status] || [null, data.status])[1];
  const head = `共 ${data.total} 个切片${data.total > data.chunks.length ? ` · 当前显示前 ${data.chunks.length} 个` : ""} · ${esc(data.source_filename)} · 任务状态 ${esc(statusLabel)}`;
  const items = data.chunks
    .map((c) => {
      const text = c.content.length > 200 ? c.content.slice(0, 200) + "…" : c.content;
      return `<div class="chunk-item">
        <div class="ci-head"><span class="ci-idx">#${c.chunk_index}</span><span class="ci-hd">${esc(c.heading_path || "（无标题路径）")}</span><span class="ci-meta">${c.char_count} 字符 · 向量 ${c.embedding_dim ?? "—"} 维 · ${esc(sealOf(c.classification)[1])}</span></div>
        <div class="ci-body">${esc(text)}</div>
      </div>`;
    })
    .join("");
  return `<div class="chunk-preview"><div class="cp-head">${head}</div>${items || '<div class="ci-empty">（无切片数据）</div>'}</div>`;
}

function startKbPoll() {
  stopKbPoll();
  const tick = async () => {
    if (!state.token || $("route-kb").hidden) return;
    const pending = await loadKbTasks();
    state.kbPollTimer = setTimeout(tick, pending ? 1500 : 4000);
  };
  state.kbPollTimer = setTimeout(tick, 1000);
}

function stopKbPoll() {
  if (state.kbPollTimer) { clearTimeout(state.kbPollTimer); state.kbPollTimer = null; }
}

async function uploadFiles(files) {
  const kbId = $("upload-kb-select").value;
  if (!kbId) { toast("请先创建并选择目标知识库", true); return; }
  for (const file of files) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    try {
      const res = await fetch(`/api/admin/kbs/${kbId}/documents`, {
        method: "POST",
        headers: { Authorization: "Bearer " + state.token },
        body: fd,
      });
      if (res.status === 401) { logout(); return; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(`上传失败：${file.name} · ${typeof body.detail === "string" ? body.detail : body.detail && body.detail.message || res.status}`, true);
        continue;
      }
      toast(body.duplicate ? `${file.name} 内容已存在，幂等返回已有任务` : `已创建入库任务 · ${file.name} 排队中`);
    } catch (err) {
      toast(`上传异常：${file.name} · ${errText(err)}`, true);
    }
  }
  await loadKbTasks();
}

async function createKb() {
  const name = $("kb-name").value.trim();
  if (!name) { toast("请输入知识库名称", true); return; }
  try {
    await api("/admin/kbs", {
      method: "POST",
      body: JSON.stringify({
        name,
        classification: $("kb-classification").value,
        description: $("kb-desc").value.trim() || null,
      }),
    });
    $("kb-name").value = "";
    $("kb-desc").value = "";
    toast(`知识库 ${name} 已创建`);
    await loadKbPage();
  } catch (err) {
    toast(errText(err), true);
  }
}

/* ============================================================
   用户与权限页
   ============================================================ */
async function loadUsersPage() {
  try {
    const [users, roles, kbs] = await Promise.all([
      api("/admin/users"),
      api("/admin/roles"),
      api("/admin/kbs"),
    ]);
    const acls = await Promise.all(kbs.map((kb) => api(`/admin/kbs/${kb.id}/acls`).catch(() => [])));
    // 矩阵：grant[role] = Set(kb_id)
    const grants = new Map();
    kbs.forEach((kb, i) => {
      acls[i].forEach((acl) => {
        if (!grants.has(acl.role)) grants.set(acl.role, new Set());
        grants.get(acl.role).add(kb.id);
      });
    });

    // 新建用户表单的角色下拉随角色表刷新（保留当前选择）
    const roleSel = $("nu-role");
    const curRole = roleSel.value;
    roleSel.innerHTML = roles.map((r) => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join("");
    if (roles.some((r) => r.name === curRole)) roleSel.value = curRole;

    const isSelf = (u) => u.username === state.user.username;
    $("user-list-body").innerHTML = users.length
      ? users
          .map((u) => {
            const time = u.created_at ? u.created_at.slice(0, 10) : "";
            const roleOpts = roles
              .map((r) => `<option value="${esc(r.name)}"${r.name === u.role ? " selected" : ""}>${esc(r.name)}</option>`)
              .join("");
            const self = isSelf(u);
            return `<tr class="clickable" data-role="${esc(u.role)}">
              <td>${esc(u.display_name || u.username)}<span class="dim" style="margin-left:8px;font-size:12px">${esc(u.username)}</span></td>
              <td><select class="op-select" data-uid="${u.id}" ${self ? 'disabled title="不能修改自己的角色"' : ""}>${roleOpts}</select></td>
              <td><span class="job-state ${u.is_active ? "js-done" : "js-fail"}">${u.is_active ? "正常" : "停用"}</span></td>
              <td><button class="op-btn${u.is_active ? " danger" : ""}" data-uid="${u.id}" data-next="${u.is_active ? "false" : "true"}" ${self && u.is_active ? 'disabled title="不能停用自己"' : ""}>${u.is_active ? "停用" : "启用"}</button></td>
              <td class="dim">${time}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="5" class="dim">暂无用户</td></tr>';
    $("user-list-body").querySelectorAll("tr.clickable").forEach((row) => {
      row.addEventListener("click", () => selectUser(row.dataset.role));
    });
    $("user-list-body").querySelectorAll(".op-select").forEach((sel) => {
      sel.addEventListener("click", (e) => e.stopPropagation());
      sel.addEventListener("change", async () => {
        try {
          await api(`/admin/users/${sel.dataset.uid}`, { method: "PATCH", body: JSON.stringify({ role: sel.value }) });
          toast(`角色已更新为 ${sel.value}`);
          loadUsersPage();
        } catch (err) {
          toast(errText(err), true);
          loadUsersPage();
        }
      });
    });
    $("user-list-body").querySelectorAll(".op-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await api(`/admin/users/${btn.dataset.uid}`, { method: "PATCH", body: JSON.stringify({ is_active: btn.dataset.next === "true" }) });
          toast(btn.dataset.next === "true" ? "用户已启用" : "用户已停用");
          loadUsersPage();
        } catch (err) {
          toast(errText(err), true);
        }
      });
    });

    const head = `<tr><th>角色</th>${kbs.map((kb) => `<th>${esc(kb.name)}</th>`).join("")}</tr>`;
    $("perm-head").innerHTML = head;
    $("perm-body").innerHTML = roles
      .map((role) => {
        const cells = kbs
          .map((kb) => {
            const allow = grants.get(role.name) && grants.get(role.name).has(kb.id);
            return `<td class="${allow ? "allow" : "deny"} toggler" data-role="${esc(role.name)}" data-kb="${kb.id}" title="点击切换该角色对此知识库的可读授权">${allow ? "可读" : "不可见"}</td>`;
          })
          .join("");
        return `<tr data-role="${esc(role.name)}"><td><span class="pill">${esc(role.name)}</span></td>${cells}</tr>`;
      })
      .join("");
    $("perm-body").querySelectorAll("td.toggler").forEach((td) => {
      td.addEventListener("click", async () => {
        const grant = td.classList.contains("allow");
        const { role, kb } = td.dataset;
        try {
          if (grant) await api(`/admin/kbs/${kb}/acls/${role}`, { method: "DELETE" });
          else await api(`/admin/kbs/${kb}/acls`, { method: "POST", body: JSON.stringify({ role }) });
          toast(grant ? `已收回 ${role} 的该库可读权限` : `已授予 ${role} 该库可读权限`);
          loadUsersPage();
        } catch (err) {
          toast(errText(err), true);
        }
      });
    });

    loadAudit();
  } catch (err) {
    toast(errText(err), true);
  }
}

function selectUser(role) {
  document.querySelectorAll("#perm-body tr").forEach((r) => {
    r.classList.toggle("sel", r.dataset.role === role);
  });
  const visible = $("perm-body").querySelectorAll(`tr[data-role="${CSS.escape(role)}"] td.allow`).length;
  toast(`${role} 的视角：可检索 ${visible} 个知识库`);
}

/* ============================================================
   审计事件（T16：域标签展示；agentdesk 域 = object_type agent_task）
   ============================================================ */
const AUDIT_DOMAIN = {
  agent_task: "Agent 工作台",
  chat: "知识问答",
  knowledge_base: "知识库",
};
const AUDIT_ACTION = {
  "agentdesk.tool_call": "工具调用",
  "agentdesk.out_of_bounds": "越界拦截",
  "agentdesk.redline_blocked": "红线命令拦截",
  "agentdesk.task_committed": "门禁提交",
  "agentdesk.approval_decided": "审批决策",
  "guard.input_masked": "输入脱敏",
  "guard.output_masked": "输出脱敏",
  "chat.ask": "会话提问",
  "retrieval.denied": "检索越权拒绝",
};

function auditDetail(e) {
  const d = e.detail || {};
  const parts = [];
  if (d.tool_name) parts.push(d.tool_name);
  if (d.tool) parts.push(d.tool);
  if (d.command) parts.push(String(d.command).slice(0, 80));
  if (d.path) parts.push(String(d.path).slice(0, 60));
  if (d.pattern) parts.push(`命中模式 ${d.pattern}`);
  if (d.decision) parts.push(d.decision);
  if (d.scope) parts.push(d.scope);
  if (d.mode) parts.push(`模式 ${d.mode}`);
  if (d.message) parts.push(String(d.message).slice(0, 80));
  return parts.join(" · ") || e.object_id || "—";
}

async function loadAudit() {
  const domain = $("audit-domain").value;
  const body = $("audit-body");
  try {
    const events = await api("/admin/audit-events?limit=200");
    const rows = events.filter((e) => !domain || e.object_type === domain);
    body.innerHTML = rows.length
      ? rows.map((e) => {
          const time = e.created_at ? e.created_at.slice(5, 19).replace("T", " ") : "—";
          const blocked = e.outcome === "blocked" || e.outcome === "denied";
          const cls = blocked ? "js-fail" : (e.outcome === "allowed" || e.outcome === "ok" ? "js-done" : "js-queued");
          const dom = AUDIT_DOMAIN[e.object_type] || e.object_type;
          const act = AUDIT_ACTION[e.action] || e.action;
          return `<tr>
            <td class="dim">${esc(time)}</td>
            <td>${esc(e.username || "—")}</td>
            <td><span class="pill">${esc(dom)}</span></td>
            <td>${esc(act)}</td>
            <td><span class="job-state ${cls}">${esc(e.outcome)}</span></td>
            <td class="dim">${esc(auditDetail(e))}</td>
          </tr>`;
        }).join("")
      : '<tr><td colspan="6" class="dim">暂无审计事件</td></tr>';
  } catch {
    body.innerHTML = '<tr><td colspan="6" class="dim">审计事件加载失败（需要管理员权限）</td></tr>';
  }
}

async function createUser() {
  const username = $("nu-username").value.trim();
  const password = $("nu-password").value;
  const display = $("nu-display").value.trim();
  const role = $("nu-role").value;
  if (!username || !password) {
    toast("请填写用户名与初始密码（≥8 位）", true);
    return;
  }
  try {
    await api("/admin/users", {
      method: "POST",
      body: JSON.stringify({ username, password, display_name: display || null, role }),
    });
    toast(`用户 ${username} 已创建（角色 ${role}）`);
    $("nu-username").value = "";
    $("nu-password").value = "";
    $("nu-display").value = "";
    loadUsersPage();
  } catch (err) {
    toast(errText(err), true);
  }
}

/* ============================================================
   事件绑定与初始化
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  $("login-btn").addEventListener("click", doLogin);
  $("lg-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
  $("lg-user").addEventListener("keydown", (e) => { if (e.key === "Enter") $("lg-pass").focus(); });
  $("oidc-link").addEventListener("click", () => toast("SSO 对接为阶段二能力（OIDC 预留）", true));
  $("logout-btn").addEventListener("click", logout);
  $("new-conv-btn").addEventListener("click", newSession);
  $("agent-chip").addEventListener("click", () => void toggleAgentPicker());
  $("model-chip").addEventListener("click", () => void toggleModelPicker());
  $("send-btn").addEventListener("click", sendQuestion);
  $("composer-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendQuestion(); }
  });
  $("upload-zone").addEventListener("click", () => $("file-input").click());
  $("upload-zone").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file-input").click(); }
  });
  $("file-input").addEventListener("change", (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) uploadFiles(files);
  });
  $("kb-create-btn").addEventListener("click", createKb);
  $("user-create-btn").addEventListener("click", createUser);
  $("audit-domain").addEventListener("change", loadAudit);
  boot();
});
