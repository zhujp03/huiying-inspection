// utils/digest.js — 浏览器端文件 SHA-256 摘要（crypto.subtle，安全上下文限定）。
// 消费小票契约（ReceiptFileMetaSchema）在 init/complete 两步都强制 64-hex sha256，
// 且服务端 complete 用它对账存储对象实测摘要（不一致 → RECEIPT_HASH_MISMATCH）——
// 因此必须在 init 之前对选中文件的真实字节计算一次，并以同一字符串贯穿整条上传链
// （init 与 complete 携带同一 64-hex 值；摘要字符串允许随待传项持久化，File/缓冲不得持久化）。
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

export function hasSha256Hex(value) {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

// file 为浏览器选图产物（File/Blob）。失败一律抛可读中文错误（页面 safeMessage 原样透传），
// 绝不返回占位/伪造摘要——服务端对账是唯一事实源。
export async function sha256Hex(file) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("图片文件已失效，请重新选择后再上传");
  if (typeof crypto === "undefined" || !crypto?.subtle) throw new Error("当前浏览器不支持文件校验，请更换浏览器后重试");
  let buffer;
  try {
    buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new Error("无法读取图片文件内容，请重新选择后再上传");
  }
}
