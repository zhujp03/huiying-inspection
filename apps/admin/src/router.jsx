import { useEffect, useRef, useSyncExternalStore } from "react";
import { rootReplacement } from "./routes.js";

// —— 极简 history 路由层（无第三方依赖）——
// 只负责：pushState/replaceState 客户端导航、popstate 订阅、未保存修改（guard）拦截。
// 路由表/解析在 routes.js（纯函数）；确认弹窗 UI 由 AdminWorkbench 注册（setNavigationConfirm）。
// 安全边界：只做站内地址切换，绝不读取 URL 参数作为跳转目标（防开放重定向）。
//
// 历史完整性（关键设计）：每个条目在 history.state 里写入单调递增的 adminIdx。
// 守卫拦截 popstate 时用 history.go(当前条目 − 目标条目) 回滚到原条目——这是真实遍历，
// 不增删条目、不销毁前进/后退链；确认放弃时再 go(目标 − 当前) 精确回到用户想去的那条
// 原始条目。push 类拦截发生在改历史之前，无需回滚。守卫支持叠加（编辑器 + 其上的弹窗
// 各自注册，任一报脏即拦截），确认弹窗始终只有一份、目标取最近一次动作（避免过期目标）。

const listeners = new Set();
const readHref = () => `${window.location.pathname}${window.location.search}`;
let current = readHref();
// 当前条目序号：初始条目（无 state）记 0；跨文档回到本应用时浏览器会还原 state.adminIdx。
let currentIdx = Number(window.history.state?.adminIdx ?? 0);

// guard 栈：编辑器/弹窗各自注册（key 唯一），任一返回 true 即视为有未保存修改。
const guards = new Map();
let guardSeq = 0;
// confirmHandler：由工作台注册，收到 { kind, href } 用于展示确认弹窗。
// pending：待裁决的拦截动作；confirmLeave/cancelLeave 由工作台在弹窗按钮里调用。
let confirmHandler = null;
let pending = null;
// rollingBackTo：正在用 history.go 回滚到的条目序号（用于识别回滚产生的 popstate）。
let rollingBackTo = null;
// bypassNext：确认放弃后放行紧接着的一次 popstate（守卫此时仍报脏，但用户已确认丢弃）。
let bypassNext = false;

export function registerNavigationGuard(handler) {
  const id = ++guardSeq;
  guards.set(id, handler);
  return () => guards.delete(id);
}
export function navigationBlocked() {
  for (const check of guards.values()) { if (check()) return true; }
  return false;
}
export function setNavigationConfirm(handler) { confirmHandler = handler || null; }

export function useAdminLocation() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    () => current,
  );
}

function apply(href, { replace = false } = {}) {
  if (replace) {
    window.history.replaceState({ ...(window.history.state || {}), adminIdx: currentIdx }, "", href);
  } else {
    const nextIdx = currentIdx + 1;
    window.history.pushState({ adminIdx: nextIdx }, "", href);
    currentIdx = nextIdx;
  }
  current = readHref();
  emit();
}

function emit() { for (const listener of listeners) listener(); }

// 受守卫约束的导航：有未保存修改时转交确认弹窗（返回 false 表示本次未跳转）。
// 同地址 push 导航是 no-op：不丢弃任何内容（无需确认）、不重复堆历史（重复点击当前菜单/
// 已选中题目不产生冗余条目）。replace 语义不受此影响（根入口规整等仍需执行）。
export function navigate(href, options = {}) {
  if (!options.replace && href === current) return true;
  if (navigationBlocked()) {
    pending = { kind: "push", href, options };
    confirmHandler?.({ kind: "push", href });
    return false;
  }
  apply(href, options);
  return true;
}

// 已确认放弃修改（或无守卫）后的强制跳转——仅用于确认裁决与同条目 replace 规整。
export function forceNavigate(href, options = {}) { apply(href, options); }

// 确认弹窗裁决：确认=执行拦截的动作（真实遍历到目标条目/推送/退出登录），取消=停留原地。
export function confirmLeave() {
  const resolved = pending;
  pending = null;
  if (!resolved) return;
  if (resolved.kind === "action") { resolved.action(); return; }
  if (resolved.kind === "push") { apply(resolved.href, resolved.options); return; }
  // traverse：go 到被拦截时的目标条目（真实遍历，不新增条目）；下一次 popstate 放行守卫。
  bypassNext = true;
  window.history.go(resolved.targetIdx - currentIdx);
}
export function cancelLeave() { pending = null; }

window.addEventListener("popstate", (event) => {
  const idx = Number(event.state?.adminIdx ?? 0);
  // 回滚落地：回到原条目，视图/表单保持不变，不重渲染。
  if (rollingBackTo !== null && idx === rollingBackTo) {
    rollingBackTo = null;
    currentIdx = idx;
    current = readHref();
    return;
  }
  if (bypassNext) {
    bypassNext = false;
    currentIdx = idx;
    current = readHref();
    emit();
    return;
  }
  const href = readHref();
  if (navigationBlocked()) {
    // 未保存修改：先 go 回原条目（真实遍历，不增删历史），再交由确认弹窗裁决；
    // 弹窗打开期间的新遍历以最近一次为目标（覆盖旧目标，避免过期跳转）。
    const targetIdx = idx;
    pending = { kind: "traverse", href, targetIdx };
    rollingBackTo = currentIdx;
    confirmHandler?.({ kind: "traverse", href });
    window.history.go(currentIdx - idx);
    return;
  }
  currentIdx = idx;
  current = href;
  emit();
});

// 刷新/关闭标签页的原生拦截：仅在脏态生效（beforeunload 无法使用自定义弹窗，属平台限制）。
window.addEventListener("beforeunload", (event) => {
  if (navigationBlocked()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

// 编辑页挂载期间注册脏态判定；卸载自动注销。getDirty 需为稳定引用（配合 useCallback）。
export function useNavigationGuard(getDirty) {
  const ref = useRef(getDirty);
  ref.current = getDirty;
  useEffect(() => registerNavigationGuard(() => Boolean(ref.current())), []);
}

// 根入口（/、/admin、/admin/、/admin/index.html）replace 为 overview：不产生冗余历史记录。
export function useRootRedirect(href) {
  useEffect(() => {
    const target = rootReplacement(href);
    if (target) apply(target, { replace: true });
  }, [href]);
}
