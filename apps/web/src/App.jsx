// 路由壳（第 3 段真实化）：
// 1) hash 路由：#/login … #/help，与 app-manifest.js 的 pages[].route 一一对应；
//    查询参数（mode/assignmentId/attemptId 等）以 ? 附加，按 inventory §4.4 消费。
// 2) 启动加载公共配置 loadPublicConfig()（services/public-config；失败 null 不重试，R12），
//    经 context 供页面做门控（authSelfService，R13）与 captchaAppId 求值。
// 3) 导航守卫：GUARDED 页（home/schedule/profile/location）无 approved 会话 → replace("/login")
//    （对齐小程序 requireApprovedSession 部署点，rules R02；会话在每次路由变化时重读 store/session）。
// 4) 401 由页面捕获 BusinessError kind=session 后统一走 context.redirectToLogin()
//    （services/adapters/http 已先行清会话，guards.handleUnauthorized，R05）。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { pages, tabs } from "./app-manifest.js";
import { TabBar, Toast } from "./design/components.jsx";
import { AppContext } from "./pages/app-context.jsx";
import {
  LoginPage, LocationPage, HomePage, SchedulePage, ProfilePage, TaskPage,
  SurveyPage, IssuePage, DishesPage, OtherPage, HelpPage,
} from "./pages/index.jsx";
import { loadPublicConfig } from "./services/public-config.js";
import { getSession } from "./store/session.js";
import { requireApprovedSession } from "./router/guards.js";
import {
  initNavLog, syncNavLogOnHashChange, recordNavPush, recordNavReplace, previousNavEntry, forgetCurrentNav,
  sanitizeTaskSource,
} from "./router/nav-history.js";

const routes = pages.map((page) => page.route);
const tabRoutes = new Set(pages.filter((page) => page.tabBar).map((page) => page.route));
const GUARDED = new Set(["/home", "/schedule", "/profile", "/location"]);

const parseHash = () => {
  const raw = window.location.hash.replace(/^#/, "") || "/login";
  const [path, query = ""] = raw.split("?");
  return { path: routes.includes(path) ? path : "/login", query: new URLSearchParams(query) };
};

// 业务身份键：业务页面在挂载时解析路由参数，同路由不同业务参数/来源的同文档跳转
// 必须以 key 重挂载重读（否则组件持有旧任务的来源/实体）。刻意排除：
// - revision（作答推进，组件内以服务端为准自愈，重挂载反而打扰未保存作答）；
// - survey 的 category（视图态，由问卷页 replace 同步进 URL，不得触发重挂载）。
const businessKeyOf = (path, query) => {
  const source = sanitizeTaskSource(query.get("source") || "");
  const ids = `${query.get("assignmentId") || ""}|${query.get("attemptId") || ""}|${query.get("questionnaireVersionId") || ""}`;
  switch (path) {
    case "/task": return `task|${query.get("assignmentId") || ""}|${source}`;
    case "/survey": return `survey|${ids}|${source}`;
    case "/issue": return `issue|${ids}|${query.get("questionId") || ""}|${query.get("target") || ""}|${source}|${query.get("category") || ""}`;
    case "/dishes": return `dishes|${ids}|${source}`;
    case "/other": return `other|${ids}|${source}`;
    case "/location": return `location|${query.get("source") === "profile" ? "profile" : "default"}`;
    default: return "";
  }
};

export default function App() {
  const [{ path, query }, setRoute] = useState(parseHash);
  const [publicConfig, setPublicConfig] = useState(null);
  const [toastState, setToastState] = useState({ message: "", visible: false });
  const toastTimerRef = useRef(null);

  useEffect(() => {
    // 应用内导航日志（按 history.state 条目身份推进/弹栈，为 back() 提供父页证据）。
    const onHashChange = () => {
      syncNavLogOnHashChange();
      setRoute(parseHash());
    };
    initNavLog(); // 每次文档装载：真刷新延续既有链；首开/外链/跨文档往返只信当前条目
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // R12：启动拉公共配置，失败（null）不重试；门控消费方保守按关处理。
  useEffect(() => {
    let cancelled = false;
    loadPublicConfig().then((config) => {
      if (!cancelled) setPublicConfig(config);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const navigate = useCallback((to) => {
    const next = String(to).startsWith("#") ? String(to) : `#${to}`;
    if (next === window.location.hash) return;
    window.location.hash = next;
    recordNavPush(next); // 同步标记并入栈，抢在异步 hashchange 之前（快速连续导航不伪造邻接）
  }, []);

  // replace：等价小程序 redirectTo / reLaunch 的「替换当前栈顶」语义。
  const replace = useCallback((to) => {
    const target = String(to).startsWith("#") ? String(to) : `#${to}`;
    if (target !== window.location.hash) window.history.replaceState(null, "", target);
    recordNavReplace(target);
    setRoute(parseHash());
  }, []);

  // PM 钉定 Web 适配点 5（inventory §4.3）：有历史则 back，否则 replace 到兜底路由。
  // 修订：window.history.length 无法证明上一条是应用内父页（外部来源同样计入）。
  // 只有应用内导航日志存在上一条、且通过 expectParent 校验（未提供校验器时仅要求
  // 上一条存在）才 history.back()；否则 replace 到调用方给定的规范兜底路由，
  // 绝不后退到外部页面或无关任务。
  const back = useCallback((fallback = "/schedule", expectParent = null) => {
    const previous = previousNavEntry();
    const parentOk = Boolean(previous) && (typeof expectParent !== "function" || expectParent(previous));
    if (parentOk) {
      forgetCurrentNav();
      window.history.back();
      return;
    }
    replace(fallback);
  }, [replace]);

  const toast = useCallback((message) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastState({ message: String(message ?? ""), visible: true });
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToastState((prev) => ({ ...prev, visible: false }));
    }, 2000);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  // PM 钉定 Web 适配点 4：401 时 services 层已清会话（guards.handleUnauthorized），
  // 页面捕获 kind=session 后统一调这里（等价 api.js:42 的 reLaunch 链）。
  const redirectToLogin = useCallback(() => {
    replace("/login");
  }, [replace]);

  // 导航守卫（rules R02）：受守卫页每次路由变化时重读会话，无 approved 会话 → replace 登录页。
  useEffect(() => {
    if (!GUARDED.has(path)) return;
    const verdict = requireApprovedSession(getSession());
    if (!verdict.ok) replace(verdict.redirect);
  }, [path, replace]);

  // 会话在每次渲染（路由变化 / context 更新）时重读，无全局订阅。
  const session = getSession();
  const contextValue = { publicConfig, session, navigate, back, replace, toast, redirectToLogin };

  const pageProps = { onNavigate: navigate };
  const businessKey = businessKeyOf(path, query);

  let content;
  switch (path) {
    case "/login":
      content = <LoginPage initialMode={query.get("mode") || ""} />;
      break;
    case "/location":
      content = <LocationPage key={businessKey} />;
      break;
    case "/profile":
      content = <ProfilePage />;
      break;
    case "/help":
      content = <HelpPage />;
      break;
    case "/home":
      content = <HomePage {...pageProps} />;
      break;
    case "/schedule":
      content = <SchedulePage {...pageProps} />;
      break;
    case "/task":
      // 返回起点由 TaskPage 按 ?source= 自证（home/schedule 白名单），不再硬编码日程。
      // 业务身份键：同文档切换任务/来源时重挂载重读参数。
      content = <TaskPage key={businessKey} {...pageProps} />;
      break;
    case "/survey":
      // category 不参与业务键（不得因视图态重挂载）；作为路由属性传入，由页面消费
      // 同文档查询变化（浏览器前进后退/外部跳转），见 SurveyPage routeCategory 效应。
      content = <SurveyPage key={businessKey} routeCategory={query.get("category") || ""} {...pageProps} />;
      break;
    // issue/dishes/other 的返回均由页面按「同任务父页证据」自证：
    // 有同任务父页才 history.back，否则 replace 携全量业务参数的规范父页。
    case "/issue":
      content = <IssuePage key={businessKey} {...pageProps} />;
      break;
    case "/dishes":
      content = <DishesPage key={businessKey} {...pageProps} />;
      break;
    case "/other":
      content = <OtherPage key={businessKey} {...pageProps} />;
      break;
    default:
      content = <LoginPage initialMode="" />;
  }

  const activeTab = tabs.includes(path.slice(1)) ? path.slice(1) : "";

  return (
    <AppContext.Provider value={contextValue}>
      <div className="app-shell">
        {content}
        {tabRoutes.has(path) ? <TabBar active={activeTab} onNavigate={navigate} /> : null}
        <Toast message={toastState.message} visible={toastState.visible} />
      </div>
    </AppContext.Provider>
  );
}
