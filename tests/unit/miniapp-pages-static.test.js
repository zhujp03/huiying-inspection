import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const mini = join(root, "apps/miniapp/miniprogram");
const read = (relative) => readFileSync(join(mini, relative), "utf8");

describe("页面静态契约（正式小程序 apps/miniapp/miniprogram）", () => {
  it("日程 WXML 不原样显示 ISO 时间字段", () => {
    const wxml = read("pages/schedule/index.wxml");
    expect(wxml).not.toContain("{{item.startsAt}}");
    expect(wxml).not.toContain("{{item.dueAt}}");
    expect(wxml).not.toContain("{{item.submittedAt}}");
  });

  it("日程页所有时间先由 JS 生成展示字段", () => {
    const js = read("pages/schedule/index.js");
    expect(js).toContain("groupAssignmentsByDate");
    // 展示字段统一在 presentation.js 生成层产生（不在 WXML 计算）。
    const presentation = read("utils/presentation.js");
    expect(presentation).toContain("displayDate");
    expect(presentation).toContain("displayTime");
    expect(presentation).toContain("displayDueDate");
    expect(presentation).toContain("formatTimeRange");
  });

  it("主要入口存在 bindtap 行为", () => {
    const home = read("pages/home/index.wxml");
    expect(home).toContain("bindtap=\"goTask\"");
    expect(home).toContain("bindtap=\"goSchedule\"");
    expect(home).toContain("bindtap=\"retry\"");
    const schedule = read("pages/schedule/index.wxml");
    expect(schedule).toContain("bindtap=\"goTask\"");
    expect(schedule).toContain("bindtap=\"retry\"");
    const profile = read("pages/profile/index.wxml");
    expect(profile).toContain("bindtap=\"openSecurity\"");
    expect(profile).toContain("bindtap=\"openPrivacy\"");
    expect(profile).toContain("bindtap=\"openHelp\"");
    expect(profile).toContain("bindtap=\"confirmLogout\"");
  });

  it("导航期间存在防重复状态", () => {
    expect(read("pages/home/index.js")).toContain("navigating");
    expect(read("pages/schedule/index.js")).toContain("navigatingId");
    expect(read("pages/task/index.js")).toContain("navigating");
    expect(read("pages/task/index.js")).toContain("phase");
    expect(read("pages/profile/index.js")).toContain("loggingOut");
  });

  it("任务详情 onUnload 防护：离开后异步回调不 setData", () => {
    const js = read("pages/task/index.js");
    expect(js).toContain("onUnload");
    expect(js).toContain("this.unloaded = true");
    expect(js).toContain("if (this.unloaded) return;");
  });

  it("任务列表缓存绑定账号并在登录/退出/401 清理", () => {
    const api = read("services/api.js");
    expect(api).toContain("assignmentCache.clear()");
    expect((api.match(/assignmentCache\.clear\(\)/g) || [])).toHaveLength(3); // 401 / login / logout
    const cache = read("store/assignments-cache.js");
    expect(cache).toContain("userId");
    expect(cache).toContain("force");
  });

  it("不引用 task-current / survey-current / 全局当前任务", () => {
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const sources = walk(mini).filter((f) => /\.(js|wxml)$/.test(f));
    for (const file of sources) {
      const content = readFileSync(file, "utf8");
      expect(content, file).not.toMatch(/task-current|survey-current|globalTask|globalSurvey/i);
    }
  });

  it("正式小程序源码不引用 fixture", () => {
    const walk = (dir) => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
    const sources = walk(mini).filter((f) => /\.(js|wxml|json)$/.test(f));
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/fixture|junde-miniapp-fixture/i);
    }
  });
});

describe("登录页自助入口契约（authSelfService 驱动）", () => {
  const wxml = read("pages/login/index.wxml");
  const js = read("pages/login/index.js");

  it("不得保留恒假死路分支（被拒页按钮可见但表单永不可达）", () => {
    expect(wxml).not.toContain('wx:if="{{false}}"');
  });

  it("注册/找回入口与重交表单块由 selfServiceEnabled 守卫", () => {
    // 入口按钮区
    expect(wxml).toContain('wx:if="{{selfServiceEnabled}}"');
    // 重交表单块：非登录模式且自助开放才渲染
    expect(wxml).toContain("mode !== 'login' && selfServiceEnabled");
  });

  it("被拒且自助关闭时给出联系管理员提示而非死按钮", () => {
    expect(wxml).toContain("selfServiceEnabled");
    expect(wxml).toContain("联系管理员");
  });

  it("JS 从 publicConfig.features.authSelfService 求值并支持刷新重取", () => {
    expect(js).toContain("authSelfService");
    expect(js).toContain("selfServiceEnabled");
    expect(js).toContain("retryPublicConfig");
  });
});

describe("冷启动会话恢复契约", () => {
  it("登录页 onLoad 探测已有会话且仅自动跳转一次", () => {
    const js = read("pages/login/index.js");
    expect(js).toContain("getMyAssignments");
    expect(js).toContain('switchTab');
    // 仅探测一次：失败不循环重试
    expect(js).toContain("sessionProbeDone");
  });
});

describe("任务详情展示字段契约", () => {
  it("任务页在 JS 层生成展示字段，不裸透传服务端字段", () => {
    const js = read("pages/task/index.js");
    expect(js).toContain("mapAssignmentStatus");
    expect(js).toContain("storeAddress");
    expect(js).toContain("budgetLimitCents");
    expect(js).toContain("formatBudgetLabel");
    expect(js).toContain("formatTimeRange");
    expect(js).toContain("Array.isArray");
  });

  it("presentation 提供预算展示函数（0 表示未设置）", () => {
    const presentation = read("utils/presentation.js");
    expect(presentation).toContain("formatBudgetLabel");
    expect(presentation).toContain("未设置");
  });
});

describe("问题页录音与音频契约", () => {
  it("recorder.onStop 只注册一次，不随开始录音重复追加", () => {
    const js = read("pages/issue/index.js");
    expect((js.match(/recorder\.onStop/g) || [])).toHaveLength(1);
    expect(js).toContain("recorderBound");
  });

  it("音频播放复用单例并在 onUnload 销毁", () => {
    const js = read("pages/issue/index.js");
    expect(js).toContain("createInnerAudioContext");
    expect(js).toContain("destroy");
    expect((js.match(/createInnerAudioContext/g) || [])).toHaveLength(1);
  });
});

describe("分数清零题契约（survey 页）", () => {
  const wxml = read("pages/survey/index.wxml");
  const js = read("pages/survey/index.js");

  it("清零题题干旁展示条件警示标签", () => {
    expect(wxml).toContain('wx:if="{{item.isScoreWipe}}"');
    expect(wxml).toContain("本题选「是」将清零本类全部得分");
  });

  it("清零题按钮文案切换为是/否，普通题保持得分/不得分", () => {
    expect(wxml).toContain("item.isScoreWipe ? '否' : '得分'");
    expect(wxml).toContain("item.isScoreWipe ? '是' : '不得分'");
  });

  it("清零题选「是」先二次确认弹窗再进 issue 流程", () => {
    expect(js).toContain("wx.showModal");
    expect(js).toContain("分数清零确认");
    expect(js).toContain("确认存在该严重问题？确认后本类目全部题目不得分。");
    expect(js).toContain("result.confirm");
  });

  it("project 映射透传 isScoreWipe", () => {
    expect(js).toContain("isScoreWipe: Boolean(item.isScoreWipe)");
  });
});

describe("其他记录页与消费小票终态契约", () => {
  it("其他记录页加载失败区域绑定 retryLoad", () => {
    const wxml = read("pages/other/index.wxml");
    expect(wxml).toContain('bindtap="retryLoad"');
  });

  it("已提交问卷的小票接口 409 映射为终态业务错误", () => {
    const api = read("services/api.js");
    expect(api).toContain("QUESTIONNAIRE_SUBMITTED");
    expect(api).toContain("questionnaire_submitted");
  });

  it("菜品页对已提交终态锁定小票重试入口（文案单一来源在 services/api.js）", () => {
    const js = read("pages/dishes/index.js");
    const wxml = read("pages/dishes/index.wxml");
    expect(js).toContain("questionnaire_submitted");
    expect(js).toContain("receiptLocked");
    expect(wxml).toContain('wx:if="{{!receiptLocked}}"');
  });
});

describe("运行时配置与品牌清理契约", () => {
  it("runtime-config 生成器禁止本机地址进入发布配置", () => {
    const script = readFileSync(join(root, "scripts/generate-miniapp-runtime-config.mjs"), "utf8");
    expect(script).toContain("isLocalhostAddress");
    expect(script).toContain("发布配置不得包含本机地址");
    // 行为级防呆（发布拒绝 / development 放行）由 miniapp-page-fixes.test.js 子进程用例覆盖。
  });

  it("tabbar 资产与图标脚本已清理 questionnaire 残留", () => {
    const assets = readdirSync(join(mini, "assets/tabbar"));
    expect(assets.some((name) => name.includes("questionnaire"))).toBe(false);
    const generator = readFileSync(join(root, "scripts/generate-tabbar-icons.mjs"), "utf8");
    expect(generator).not.toContain("questionnaire");
  });

  it("project.config.json 品牌为汇盈探店且保留正式 AppID", () => {
    const config = JSON.parse(readFileSync(join(root, "apps/miniapp/project.config.json"), "utf8"));
    expect(config.appid).toBe("wx35690c1079fb5a5d");
    expect(config.miniprogramRoot).toBe("miniprogram/");
    expect(config.description).toContain("汇盈探店");
    expect(config.projectname).not.toContain("junde");
    expect(config.projectname).not.toContain("小马");
    expect(config.description).not.toContain("小马");
  });

  it("帮助页文案不依赖具体题量与分类数", () => {
    const wxml = read("pages/help/index.wxml");
    expect(wxml).not.toContain("50 道题");
    expect(wxml).not.toContain("三部分");
  });

  it("app.js 使用共享契约取 client-config 路径", () => {
    const app = read("app.js");
    expect(app).toContain("API.public.clientConfig");
    expect(app).not.toContain('"/api/public/client-config"');
  });
});

describe("答题二值收口契约（探员端不出现分值概念）", () => {
  const surveyWxml = read("pages/survey/index.wxml");
  const issueWxml = read("pages/issue/index.wxml");
  const surveyJs = read("pages/survey/index.js");
  const issueJs = read("pages/issue/index.js");

  it("survey/issue 页不展示分值且源码无分值概念", () => {
    expect(surveyWxml).not.toContain("{{item.score}}");
    expect(issueWxml).not.toContain("{{question.score}}");
    expect(surveyWxml).not.toMatch(/}}分/);
    expect(issueWxml).not.toMatch(/}}分/);
    for (const content of [surveyWxml, issueWxml, surveyJs, issueJs]) {
      expect(content).not.toContain("maxScore");
      expect(content).not.toContain("满分");
      expect(content).not.toContain("分值");
    }
  });

  it("不得分必填文字说明链路存在（textarea + 前置校验 + 后端错误透传）", () => {
    expect(issueWxml).toContain('bindinput="remark"');
    expect(issueWxml).toContain("textarea");
    expect(issueWxml).toContain("必填");
    expect(issueWxml).toContain("请描述现场看到的问题");
    expect(issueJs).toContain("remark.trim()");
    expect(issueJs).toContain("请填写问题说明");
    expect(issueJs).toContain("this.message(error.message)");
  });

  it("答题按钮文案统一为得分/不得分", () => {
    expect(surveyWxml).toContain("'得分'");
    expect(surveyWxml).toContain("'不得分'");
  });
});
