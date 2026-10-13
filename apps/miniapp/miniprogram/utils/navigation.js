// 探店流程导航辅助：任务链来源白名单 + 同任务父页校验 + 安全返回。
//
// 背景：wx.navigateBack 只看页面栈深度，getCurrentPages().length > 1 不能证明
// 上一页是「同一个任务」的正确父页（直达进入/分享路径/无关栈都会误判）。
// 这里在原生返回前校验紧邻父页的 route 与业务 ID（assignmentId/attemptId），
// 不匹配时 redirectTo 携全量业务参数的规范父页 URL，绝不退出小程序或落到无关任务。
//
// 边界：来源/分类只作为路由参数传递，不进入草稿存储身份（store/survey.js 键不变），
// 不改变任何 API 契约。

// 任务链来源白名单：home/schedule/profile 之外的值一律归空串（调用方按默认起点处理）。
export function sanitizeSource(value) {
  return ["home", "schedule", "profile"].includes(value) ? value : "";
}

// 任务详情页的返回起点（switchTab 只能落 tab 页）：source=home → 首页，否则日程。
export function taskOriginTab(source) {
  return source === "home" ? "/pages/home/index" : "/pages/schedule/index";
}

// 任务详情页返回按钮文案与实际去向一致。
export function taskOriginLabel(source) {
  return source === "home" ? "返回首页" : "返回日程";
}

// 紧邻父页（栈顶的下一页）；页面栈不足两层或环境缺失时返回 null。
export function parentPage() {
  try {
    const pages = getCurrentPages();
    return pages.length >= 2 ? pages[pages.length - 2] : null;
  } catch {
    return null;
  }
}

// 紧邻父页是否为指定页面（route 以 routeSuffix 结尾）且业务 ID 一致。
// meta 只传任务身份键（assignmentId/attemptId 等）；revision 刻意不参与比较——
// 父页 onLoad options 里的 revision 是挂载时的旧值，作答后服务端 revision 单调前进。
export function parentIsPage(routeSuffix, meta) {
  const parent = parentPage();
  if (!parent || !String(parent.route || "").endsWith(routeSuffix)) return false;
  const options = parent.options || {};
  return (!meta || Object.entries(meta).every(([key, value]) => value === undefined || String(options[key] ?? "") === String(value)));
}

// 同任务父页在栈上才原生返回；否则整页替换到规范父页（fallbackUrl 需携全量业务参数）。
export function backToParentOrRedirect({ parentRoute, meta, fallbackUrl }) {
  if (parentIsPage(parentRoute, meta)) {
    wx.navigateBack();
    return;
  }
  wx.redirectTo({ url: fallbackUrl });
}
