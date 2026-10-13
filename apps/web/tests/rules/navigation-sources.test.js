// 探店员端导航来源修复（Web 侧）静态契约：页面源码必须按「业务来源/同任务父页证据」
// 导航，禁止回退到硬编码日程/缺参问卷/裸 history.back。行为回归由 h5-local e2e 承接。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

const appSource = read("src/App.jsx");
const taskPage = read("src/pages/TaskPage.jsx");
const surveyPage = read("src/pages/SurveyPage.jsx");
const dishesPage = read("src/pages/DishesPage.jsx");
const otherPage = read("src/pages/OtherPage.jsx");
const issuePage = read("src/pages/IssuePage.jsx");
const locationPage = read("src/pages/LocationPage.jsx");
const profilePage = read("src/pages/ProfilePage.jsx");
const homePage = read("src/pages/HomePage.jsx");
const schedulePage = read("src/pages/SchedulePage.jsx");

describe("App 壳：返回基于条目身份+光标的导航日志，业务身份变化显式重挂载", () => {
  it("back 走 nav-history 父页证据，证据缺失/校验失败 replace 兜底", () => {
    expect(appSource).toContain("previousNavEntry");
    expect(appSource).toContain("forgetCurrentNav");
    expect(appSource).toContain("recordNavReplace");
    expect(appSource).toContain("recordNavPush");
    expect(appSource).toContain("syncNavLogOnHashChange");
    expect(appSource).toContain("initNavLog");
    expect(appSource).toMatch(/expectParent/);
    // 旧实现（仅凭 history.length 判定可后退）必须移除。
    expect(appSource).not.toContain("window.history.length > 1");
  });

  it("业务身份键：task/survey/dishes/other/issue/location 按 ID+source 重挂载，排除 revision 与 survey category", () => {
    expect(appSource).toContain("const businessKey = businessKeyOf(path, query);");
    expect(appSource).toMatch(/<TaskPage key=\{businessKey\}/);
    expect(appSource).toMatch(/<SurveyPage key=\{businessKey\}/);
    expect(appSource).toMatch(/<IssuePage key=\{businessKey\}/);
    expect(appSource).toMatch(/<LocationPage key=\{businessKey\}/);
    const keyFn = appSource.slice(appSource.indexOf("const businessKeyOf"), appSource.indexOf("export default function App"));
    expect(keyFn).toMatch(/case "\/task": return `task\|\$\{query\.get\("assignmentId"\) \|\| ""\}\|\$\{source\}`;/);
    // survey 键不含 revision/category（作答推进与视图态不得整页重挂载）。
    const surveyKey = keyFn.slice(keyFn.indexOf('case "/survey"'), keyFn.indexOf('case "/issue"'));
    expect(surveyKey).not.toContain("revision");
    expect(surveyKey).not.toContain("category");
    // location 键只随来源变化。
    expect(keyFn).toMatch(/case "\/location": return `location\|\$\{query\.get\("source"\) === "profile" \? "profile" : "default"\}`;/);
  });

  it("应用自身 push 同步标记（recordNavPush），快速连续导航不伪造邻接", () => {
    expect(appSource).toMatch(/window\.location\.hash = next;\s*\n\s*recordNavPush\(next\);/);
  });

  it("页面返回自证：App 不再注入硬编码返回（task→日程 / dishes→固定分类问卷 / issue 缺参问卷）", () => {
    expect(appSource).not.toContain("onBackToSchedule");
    expect(appSource).not.toContain('onCancel={() => back("/survey")}');
    expect(appSource).not.toContain('navigate("/survey?category=product")');
    expect(appSource).not.toContain('onDone={() => navigate("/schedule")}');
  });
});

describe("任务页：返回随 ?source 白名单（home/schedule），进入问卷压栈保留父页", () => {
  it("返回起点用校验后退（原生 pop，不产生 bounce 条目），文案与去向一致", () => {
    expect(taskPage).toContain("sanitizeTaskSource");
    expect(taskPage).toContain('const originPath = sourceRef.current === "home" ? "/home" : "/schedule";');
    expect(taskPage).toContain("back(originPath, (previous) => navEntryIsPage(previous, originPath))");
    expect(taskPage).toContain('"返回首页"');
    expect(taskPage).toContain('"返回日程"');
    expect(taskPage).toContain("{originLabel}");
    // 不允许退化为 push（push 会让浏览器后退重访任务，形成 bounce）。
    expect(taskPage).not.toMatch(/backToOrigin[^}]*navigate\(/);
    // 业务来源由挂载时解析 + App 业务键重挂载保证新鲜；replace 已无使用处。
    expect(taskPage).toMatch(/const \{ back, navigate, toast, redirectToLogin \} = useApp\(\);/);
  });

  it("进入问卷改为压栈（navigate），保留任务为问卷父页（浏览器后退不再跳过任务）", () => {
    const openSurvey = taskPage.slice(taskPage.indexOf("const openSurvey"), taskPage.indexOf("// 继续填写"));
    expect(openSurvey).toMatch(/navigate\(`\/survey\?/);
    expect(openSurvey).not.toMatch(/replace\(`\/survey\?/);
    expect(openSurvey).toMatch(/revision=\$\{meta\.revision\}&source=\$\{sourceRef\.current\}/);
  });
});

describe("问卷页：顶部返回校验后退到同任务 + 分类会话级记忆 + 问题页带全量参数", () => {
  it("backToTask 校验 /task + assignmentId 后原生后退，否则 replace 携来源任务 URL", () => {
    expect(surveyPage).toContain('<PageNav title="暗访问卷" onBack={backToTask} />');
    expect(surveyPage).toMatch(/back\(taskUrl, \(previous\) => navEntryIsPage\(previous, "\/task", \{ assignmentId: current\.assignmentId \}\)\)/);
    expect(surveyPage).toMatch(/replace\("\/home"\)/);
  });

  it("同文档 category 查询变化经 routeCategory 属性消费（不重挂载/不打断在途保存）", () => {
    expect(appSource).toMatch(/<SurveyPage key=\{businessKey\} routeCategory=\{query\.get\("category"\) \|\| ""\}/);
    const effect = surveyPage.slice(surveyPage.indexOf("同文档路由的 category 查询变化"), surveyPage.indexOf("const retry ="));
    expect(effect).toContain("}, [routeCategory]);");
    expect(effect).toContain("routeCategory === latestRef.current.category");
    expect(effect).toContain('latestRef.current.categories || []');
    expect(effect).toContain("rememberSurveyCategory(routeMetaRef.current?.attemptId, routeCategory)");
  });

  it("分类选择写入 survey-view 并同步规范 URL（replace 不加历史）；路由指定分类仍最优先（R33/R40）", () => {
    expect(surveyPage).toContain("rememberSurveyCategory(routeMetaRef.current?.attemptId, id)");
    expect(surveyPage).toContain("recallSurveyCategory(routeMetaRef.current?.attemptId)");
    const applySelection = surveyPage.slice(surveyPage.indexOf("const applyCategorySelection"), surveyPage.indexOf("const selectCategory"));
    expect(applySelection).toContain("search.set(\"category\", id)");
    expect(applySelection).toMatch(/replace\(`#\$\{path\}\?\$\{search\.toString\(\)\}`\)/);
    // 守卫切换分类走同一落地（URL 同步）。
    expect(surveyPage).toContain("applyCategorySelection(missing.category);");
    const apply = surveyPage.slice(surveyPage.indexOf("const applyCategories"), surveyPage.indexOf("const load = async"));
    expect(apply).toContain("const pending = pendingCategoryRef.current;");
    expect(apply.indexOf("pendingCategoryRef.current")).toBeLessThan(apply.indexOf("recallSurveyCategory"));
  });

  it("已提交只读回跳、问题页与菜品进入均携带任务来源与分类", () => {
    expect(surveyPage).toMatch(/\/task\?assignmentId=\$\{encodeURIComponent\(routeMeta\.assignmentId\)\}&source=\$\{sourceRef\.current\}/);
    expect(surveyPage).toMatch(/&source=\$\{sourceRef\.current\}&category=\$\{encodeURIComponent\(latestRef\.current\.category\)\}/);
    expect(surveyPage).toMatch(/&revision=\$\{current\.revision\}&source=\$\{sourceRef\.current\}`\);/);
  });
});

describe("菜品/其他页：仅同任务父页才 history.back，兜底链保留来源", () => {
  it("菜品回问卷校验 /survey + assignmentId + attemptId；守卫强制替换保留 category=product 与来源", () => {
    expect(dishesPage).toContain('navEntryIsPage(previous, "/survey"');
    expect(dishesPage).toContain("&category=product&source=${sourceRef.current}");
    expect(dishesPage).not.toContain("window.history.length > 1");
  });

  it("菜品只读回跳任务详情与进入其他记录页均携带来源", () => {
    expect(dishesPage).toMatch(/&source=\$\{sourceRef\.current\}`\);/);
  });

  it("其他页回菜品校验 /dishes + assignmentId + attemptId，兜底携来源；保存先行语义保留（R73/R74）", () => {
    expect(otherPage).toContain('navEntryIsPage(previous, "/dishes"');
    expect(otherPage).not.toContain("window.history.length > 1");
    expect(otherPage).toMatch(/const saved = await saveRecords\(\);[\s\S]{0,240}back\(`\$\{routeUrl\("\/dishes", routeMetaRef\.current\)\}&source=\$\{sourceRef\.current\}`/);
  });

  it("其他页只读回跳任务详情携带来源；提交成功仍回日程（政策不变）", () => {
    expect(otherPage).toMatch(/\/task\?assignmentId=\$\{encodeURIComponent\(routeMetaRef\.current\.assignmentId\)\}&source=\$\{sourceRef\.current\}/);
    expect(otherPage).toContain('const done = () => { navigate("/schedule"); };');
  });
});

describe("问题页：返回校验后退到同任务问卷，兜底链携 4 参 + 来源 + 分类", () => {
  it("校验同任务问卷父页；fallback 携 source（路由参数优先于会话记忆的分类）", () => {
    expect(issuePage).toContain('navEntryIsPage(previous, "/survey"');
    expect(issuePage).toContain("sanitizeTaskSource(params.get(\"source\") || \"\")");
    expect(issuePage).toContain('categoryParamRef.current = params.get("category") || "";');
    expect(issuePage).toContain("categoryParamRef.current || recallSurveyCategory(meta.attemptId)");
    expect(issuePage).toMatch(/&source=\$\{sourceRef\.current\}\$\{category \? `&category=/);
    expect(issuePage).not.toContain('back("/survey")');
    expect(issuePage).toMatch(/function IssuePage\(\)/);
  });
});

describe("定位说明/列表页：来源链路与真实后退", () => {
  it("profile 来源：返回/完成用校验后退（不 bounce）；登录/直达完成 replace 进首页", () => {
    expect(locationPage).toContain('routeQuery().get("source") === "profile" ? "profile" : ""');
    expect(locationPage).toContain('back("/profile", (previous) => navEntryIsPage(previous, "/profile"))');
    expect(locationPage).toMatch(/complete = \(\) => \(source === "profile" \? goProfile\(\) : replace\("\/home"\)\)/);
    expect(locationPage).toContain('"返回我的"');
    expect(locationPage).toContain('"进入首页"');
    // 旧固定去向/固定标签必须移除。
    expect(locationPage).not.toContain('navigate("/schedule")');
    expect(locationPage).not.toContain("查看我的任务");
    expect(locationPage).not.toMatch(/complete[^}]*navigate\("/);
  });

  it("我的页隐私入口携 source=profile；首页/日程进任务分别携带来源", () => {
    expect(profilePage).toContain('navigate("/location?source=profile")');
    expect(homePage).toContain("&source=home");
    expect(schedulePage).toContain("&source=schedule");
  });
});
