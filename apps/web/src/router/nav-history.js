// router/nav-history.js — 有界应用内导航日志（探店员端「返回」的父页证据）。
//
// window.history.length 不能证明上一条是应用内父页；仅凭 URL 也不行。这里给每条
// 应用内历史条目写入 history.state.jundeNavId 身份，日志按「条目身份 + 光标」维护：
// - 后退/前进/跳转到已知条目：光标移动，保留其后的前进记录（多步 go(-2)/go(2) 后
//   相邻关系仍然正确——后退不得丢弃 forward 记录）；
// - 新前进条目（应用 push / 手动改 hash）：按浏览器语义丢弃光标之后的旧 forward 分支，
//   追加为新条目；应用自身的 push 由 recordNavPush 同步标记，快速连续事件不造假证据；
// - replace：光标所在条目原位改写，物理 forward 历史不受影响；
// - 整页文档装载：仅 reload 延续既有链（浏览器历史未变）；首开/外链/跨文档往返只信
//   当前条目（相邻条目未知，宁可降级也不假设邻接）。
// sessionStorage（每 tab 独立、上限 32 条）在 reload 间延续；读写失败一律静默降级为
// 「无父页证据」，调用方 replace 兜底，绝不 history.back 出应用。

const NAV_LOG_KEY = "junde:nav-log";
const NAV_LOG_LIMIT = 32;
let seq = 0;

function freshId() {
  seq += 1;
  return `nav-${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLog() {
  try {
    const raw = sessionStorage.getItem(NAV_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || !Array.isArray(parsed.list) || !Number.isInteger(parsed.cursor)) return { list: [], cursor: 0 };
    const list = parsed.list
      .filter((item) => item && typeof item.id === "string" && typeof item.hash === "string")
      .slice(-NAV_LOG_LIMIT);
    const cursor = Math.min(Math.max(parsed.cursor, 0), list.length - 1);
    return { list, cursor: Math.max(cursor, 0) };
  } catch {
    return { list: [], cursor: 0 };
  }
}

function writeLog(log) {
  try {
    sessionStorage.setItem(NAV_LOG_KEY, JSON.stringify(log));
  } catch { /* 存储不可用：按无父页证据处理 */ }
}

export function currentNavEntry() {
  return String((typeof window !== "undefined" && window.location.hash) || "");
}

function currentStateId() {
  try {
    const state = typeof history !== "undefined" ? history.state : null;
    return state && typeof state === "object" ? String(state.jundeNavId || "") : "";
  } catch {
    return "";
  }
}

function markCurrentEntry(id) {
  try {
    const previous = history.state && typeof history.state === "object" ? history.state : {};
    history.replaceState({ ...previous, jundeNavId: id }, "");
  } catch { /* 标记失败：该条目按未标记处理 */ }
}

// 本次文档装载是否延续既有会话：仅 reload（真刷新）日志仍与浏览器相邻历史一致。
function documentContinuesSession() {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return false;
    const [timing] = performance.getEntriesByType("navigation") || [];
    return timing?.type === "reload";
  } catch {
    return false;
  }
}

// App 挂载（每次文档装载）调用：重建或延续日志，并确保当前条目已标记身份。
export function initNavLog() {
  const entry = currentNavEntry();
  if (documentContinuesSession()) {
    const log = readLog();
    const current = log.list[log.cursor];
    if (current && current.hash === entry && currentStateId() === current.id) return; // 真刷新：既有链有效
  }
  const id = currentStateId() || freshId();
  markCurrentEntry(id);
  writeLog({ list: [{ id, hash: entry }], cursor: 0 });
}

// hash 变化后同步日志：按条目身份移动光标（保留 forward 记录）。
// 身份未知时分两类：未标记（stateId 空）= 新前进 push（丢弃 forward 分支后入栈）；
// 已标记但不在日志（被 32 条上限挤出/跨版本文档）= 邻接关系未知，降级为「仅当前条目」
// 的单例证据——绝不能当作与光标条目相邻的新 push（否则原生后退会伪造父页、跳出应用）。
export function syncNavLogOnHashChange() {
  const entry = currentNavEntry();
  const stateId = currentStateId();
  const log = readLog();
  const index = stateId ? log.list.findIndex((item) => item.id === stateId) : -1;
  if (index !== -1) {
    if (index !== log.cursor) writeLog({ list: log.list, cursor: index }); // 已知条目：仅移动光标
    return;
  }
  if (stateId) {
    writeLog({ list: [{ id: stateId, hash: entry }], cursor: 0 }); // 旧标记条目：单例降级
    return;
  }
  // 未标记条目：新前进——丢弃光标之后的旧 forward 分支（与浏览器 push 语义一致）。
  const id = freshId();
  markCurrentEntry(id);
  let list = [...log.list.slice(0, log.cursor + 1), { id, hash: entry }];
  let cursor = list.length - 1;
  if (list.length > NAV_LOG_LIMIT) {
    list = list.slice(list.length - NAV_LOG_LIMIT);
    cursor = list.length - 1;
  }
  writeLog({ list, cursor });
}

// 应用自身 push（App.navigate）同步调用：立即标记并入栈，抢在异步 hashchange 之前，
// 快速连续导航不产生无标记条目、不伪造邻接证据。同样丢弃光标后的旧 forward 分支。
export function recordNavPush(entry) {
  const id = freshId();
  markCurrentEntry(id);
  const log = readLog();
  let list = [...log.list.slice(0, log.cursor + 1), { id, hash: entry }];
  let cursor = list.length - 1;
  if (list.length > NAV_LOG_LIMIT) {
    list = list.slice(list.length - NAV_LOG_LIMIT);
    cursor = list.length - 1;
  }
  writeLog({ list, cursor });
}

// replace 语义（redirectTo / reLaunch / 视图态 URL 同步）：光标条目原位改写，
// 保留物理 forward 历史；条目身份沿用现标记或重新标记。
export function recordNavReplace(entry) {
  const log = readLog();
  let id = currentStateId();
  const known = id && log.list.some((item) => item.id === id);
  if (!known) {
    id = freshId();
    markCurrentEntry(id);
  }
  const list = log.list.length ? [...log.list.slice(0, log.cursor), { id, hash: entry }, ...log.list.slice(log.cursor + 1)] : [{ id, hash: entry }];
  writeLog({ list, cursor: log.list.length ? log.cursor : 0 });
}

// 上一条应用内路由（没有则 null）——「可以安全 history.back()」的唯一证据。
export function previousNavEntry() {
  const log = readLog();
  return log.cursor > 0 ? log.list[log.cursor - 1].hash : null;
}

// 与 window.history.back() 配对调用：光标先退一格（随后的 hashchange 按身份对齐为 no-op）。
export function forgetCurrentNav() {
  const log = readLog();
  if (log.cursor > 0) writeLog({ list: log.list, cursor: log.cursor - 1 });
}

// 判断一条日志是否为指定页面且指定查询参数完全一致（业务父页校验）。
export function navEntryIsPage(entry, path, params) {
  if (typeof entry !== "string") return false;
  const [entryPath, query = ""] = entry.replace(/^#/, "").split("?");
  if (entryPath !== path) return false;
  const search = new URLSearchParams(query);
  return Object.entries(params || {}).every(([key, value]) => String(search.get(key) ?? "") === String(value));
}

// 任务链业务参数白名单：来源只允许 home/schedule（其余一律按默认 schedule 处理，
// 保证非法/外部构造的 source 无法把用户带出应用）。
export function sanitizeTaskSource(value) {
  return value === "home" ? "home" : "schedule";
}
