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

const routes = pages.map((page) => page.route);
const tabRoutes = new Set(pages.filter((page) => page.tabBar).map((page) => page.route));
const GUARDED = new Set(["/home", "/schedule", "/profile", "/location"]);

const parseHash = () => {
  const raw = window.location.hash.replace(/^#/, "") || "/login";
  const [path, query = ""] = raw.split("?");
  return { path: routes.includes(path) ? path : "/login", query: new URLSearchParams(query) };
};

export default function App() {
  const [{ path, query }, setRoute] = useState(parseHash);
  const [publicConfig, setPublicConfig] = useState(null);
  const [toastState, setToastState] = useState({ message: "", visible: false });
  const toastTimerRef = useRef(null);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
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
  }, []);

  // replace：等价小程序 redirectTo / reLaunch 的「替换当前栈顶」语义。
  const replace = useCallback((to) => {
    const target = String(to).startsWith("#") ? String(to) : `#${to}`;
    if (target !== window.location.hash) window.history.replaceState(null, "", target);
    setRoute(parseHash());
  }, []);

  // PM 钉定 Web 适配点 5（inventory §4.3）：有历史则 back，否则 replace 到兜底路由。
  const back = useCallback((fallback = "/schedule") => {
    if (window.history.length > 1) window.history.back();
    else replace(fallback);
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

  let content;
  switch (path) {
    case "/login":
      content = <LoginPage initialMode={query.get("mode") || ""} />;
      break;
    case "/location":
      content = <LocationPage />;
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
      content = <TaskPage onBackToSchedule={() => navigate("/schedule")} {...pageProps} />;
      break;
    case "/survey":
      content = <SurveyPage {...pageProps} />;
      break;
    case "/issue":
      content = <IssuePage onCancel={() => back("/survey")} {...pageProps} />;
      break;
    case "/dishes":
      content = <DishesPage onBack={() => navigate("/survey?category=product")} {...pageProps} />;
      break;
    case "/other":
      content = <OtherPage onBack={() => navigate("/dishes")} onDone={() => navigate("/schedule")} {...pageProps} />;
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
