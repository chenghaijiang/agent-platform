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

/* ============================================================
   登录 / 登出 / 启动恢复
   ============================================================ */
function logout() {
  state.token = "";
  state.user = null;
  state.currentSessionId = null;
  state.sessions = [];
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
    state.sessions = await api("/sessions");
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
      return `<div class="conv-item${on}" data-sid="${s.id}">
        <div class="t">${esc(s.title || "新会话")}</div>
        <div class="m">${esc(time)}</div>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".conv-item").forEach((el) => {
    el.addEventListener("click", () => openSession(el.dataset.sid));
  });
}

async function newSession() {
  try {
    const s = await api("/sessions", { method: "POST", body: JSON.stringify({ title: null }) });
    state.sessions.unshift(s);
    state.currentSessionId = s.id;
    $("chat-inner").innerHTML = ""; // 清空上一会话的问答块，避免残留
    renderSessions();
    renderCites([], null);
    toast("已创建新会话");
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

function citeCard(c, i) {
  const [sealCls, sealText] = sealOf(c.classification);
  const doc = c.document + (c.heading_path ? ` · ${c.heading_path}` : "");
  const chunk = c.content && c.content.length > 160 ? c.content.slice(0, 160) + "…" : c.content;
  return `<div class="cite-card" data-cite="${i + 1}">
    <span class="seal-tag ${sealCls}">${sealText}</span>
    <div class="doc">${esc(doc)}</div>
    <div class="chunk">${esc(chunk)}</div>
    <div class="foot"><span class="src">${esc(c.kb_name)} · chunk ${esc(String(c.chunk_id).slice(0, 8))}</span><span>相似度 ${Number(c.score).toFixed(2)}</span></div>
  </div>`;
}

function renderCites(citations, runId) {
  const list = $("cite-list");
  const meta = $("cite-meta");
  if (!citations.length) {
    meta.textContent = "0 条证据 · 本次回答未引用知识库";
    list.innerHTML = '<div class="cite-empty">无引用来源<br>该回答未命中知识库</div>';
    return;
  }
  meta.textContent = `${citations.length} 条证据 · ACL 过滤后命中${runId ? " · Run " + runId.slice(0, 8) : ""}`;
  list.innerHTML = citations.map((c, i) => citeCard(c, i)).join("");
  list.querySelectorAll(".cite-card").forEach((card, i) => {
    setTimeout(() => {
      card.classList.add("shown");
      const s = card.querySelector(".seal-tag");
      if (s) s.classList.add("shown");
    }, state.sending ? i * 220 : 0);
  });
}

function bindCites(scope) {
  scope.querySelectorAll(".cite").forEach((tag) => {
    const target = document.querySelector(`.cite-card[data-cite="${tag.dataset.c}"]`);
    if (!target) return;
    tag.addEventListener("mouseenter", () => target.classList.add("hl"));
    tag.addEventListener("mouseleave", () => target.classList.remove("hl"));
    tag.addEventListener("click", () => target.scrollIntoView({ behavior: "smooth", block: "center" }));
  });
}

function highlightBlock(block, citations, runId) {
  // 问答块 ↔ 引用面板联动：点击任意历史问答块，右侧面板切换到该轮的引用
  document.querySelectorAll("#chat-inner .a-block").forEach((b) => b.classList.remove("cur"));
  block.classList.add("cur");
  renderCites(citations || [], runId);
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

function appendCiteRow(bodyEl, citations) {
  if (!citations.length) return;
  const row = document.createElement("div");
  row.className = "cite-row";
  row.innerHTML =
    '<span class="cite-label">引用：</span>' +
    citations.map((_, i) => `<span class="cite" data-c="${i + 1}">${i + 1}</span>`).join("");
  bodyEl.appendChild(row);
  bindCites(bodyEl);
}

function appendQuestion(inner, text) {
  const wrap = document.createElement("div");
  wrap.className = "q-bubble";
  wrap.innerHTML = `<div class="txt">${esc(text)}</div>`;
  inner.appendChild(wrap);
}

function buildAnswerBlock(inner, runId) {
  const block = document.createElement("div");
  block.className = "a-block";
  block.innerHTML = `
    <div class="a-head"><span class="who">知识助手</span><span class="meta">${runId ? "Run " + runId.slice(0, 8) : ""}</span></div>
    <div class="a-body"><span class="empty-hint">正在检索知识库…</span></div>
    <div class="gov-strip" hidden></div>`;
  inner.appendChild(block);
  return block;
}

async function openSession(sessionId) {
  state.currentSessionId = sessionId;
  renderSessions();
  const inner = $("chat-inner");
  inner.innerHTML = "";
  try {
    const runs = await api(`/sessions/${sessionId}/runs`);
    const ordered = [...runs].reverse(); // API 降序 → 时间升序渲染
    if (!ordered.length) {
      inner.innerHTML = `<div class="chat-empty"><div class="t">向知识助手提问</div><div class="s">回答基于你有权访问的知识库生成，每条结论均可追溯引用来源</div></div>`;
      renderCites([], null);
      return;
    }
    let lastCitations = [];
    let lastRunId = null;
    let lastBlock = null;
    for (const run of ordered) {
      appendQuestion(inner, run.question);
      const runId = run.id;
      const block = buildAnswerBlock(inner, runId);
      const body = block.querySelector(".a-body");
      const cites = run.citations || [];
      block.title = "点击查看该轮回答的引用来源";
      block.addEventListener("click", () => highlightBlock(block, cites, runId));
      if (run.status === "failed") {
        body.classList.add("err");
        body.innerHTML = `<p>本次回答执行失败：${esc(run.error || "未知错误")}</p>`;
      } else if (run.answer) {
        const p = document.createElement("p");
        p.textContent = run.answer;
        body.innerHTML = "";
        body.appendChild(p);
        lastCitations = cites;
        lastRunId = runId;
        lastBlock = block;
        appendCiteRow(body, cites);
        fillGov(block.querySelector(".gov-strip"), runId);
      } else {
        body.innerHTML = '<p class="empty-hint">（执行中或未产生回答）</p>';
      }
    }
    renderCites(lastCitations, lastRunId);
    if (lastBlock) lastBlock.classList.add("cur");
    scrollBottom();
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
  if (!state.currentSessionId) {
    try {
      const s = await api("/sessions", { method: "POST", body: JSON.stringify({ title: question.slice(0, 20) }) });
      state.sessions.unshift(s);
      state.currentSessionId = s.id;
      renderSessions();
    } catch (err) { toast(errText(err), true); return; }
  }
  if (state.sending) return;
  setSending(true);
  input.value = "";

  const inner = $("chat-inner");
  inner.querySelector(".chat-empty") && inner.querySelector(".chat-empty").remove();
  appendQuestion(inner, question);
  const block = buildAnswerBlock(inner, null);
  const body = block.querySelector(".a-body");
  scrollBottom();

  let answer = "";
  const p = document.createElement("p");
  body.innerHTML = "";
  body.appendChild(p);

  const finish = (runId, citations, failed) => {
    p.textContent = answer;
    if (!answer) body.innerHTML = `<p class="empty-hint">${esc(failed || "未产生回答")}</p>`;
    appendCiteRow(body, citations || []);
    fillGov(block.querySelector(".gov-strip"), runId);
    block.querySelector(".meta").textContent = runId ? "Run " + runId.slice(0, 8) : "";
    highlightBlock(block, citations || [], runId);
    setSending(false);
    scrollBottom();
    loadSessions(); // 刷新会话列表顺序
  };

  try {
    const res = await fetch(`/api/sessions/${state.currentSessionId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({ question }),
    });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json()).detail || detail; } catch { /* noop */ }
      body.classList.add("err");
      p.textContent = `提问失败：${res.status} ${detail}`;
      setSending(false);
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
        if (frame.event === "delta") {
          answer += frame.payload.text;
          p.textContent = answer;
          p.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
          scrollBottom();
        } else if (frame.event === "done") {
          finish(frame.payload.run_id, frame.payload.citations, null);
        } else if (frame.event === "error") {
          body.classList.add("err");
          finish(frame.payload.run_id || null, null, frame.payload.message);
        }
      }
    }
    if (state.sending) finish(null, null, "连接中断");
  } catch (err) {
    body.classList.add("err");
    p.textContent = `连接异常：${errText(err)}`;
    setSending(false);
  }
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
  boot();
});
