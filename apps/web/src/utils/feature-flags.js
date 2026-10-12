// utils/feature-flags.js（module-contracts §5.5；小程序 login/index.js:55、dishes/index.js:34）
//
// 语义（R13-R16）：
// - isSelfServiceEnabled(publicConfig)：publicConfig?.features?.authSelfService === true 才 true，
//   其余（null/undefined/缺 features/非严格 true）一律 false（保守隐藏注册/找回/重交入口）。
// - isReceiptOcrEnabled(publicConfig)：publicConfig?.features?.receiptOcr === true 才 true
//   （OCR 面板保守隐藏；无模块级缓存，每次调用按传入值重求值——R16 配置晚到可补显）。

export function isSelfServiceEnabled(publicConfig) {
  return publicConfig?.features?.authSelfService === true;
}

export function isReceiptOcrEnabled(publicConfig) {
  return publicConfig?.features?.receiptOcr === true;
}
