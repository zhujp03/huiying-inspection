// 附件内容魔数闸：上传完成后按声明类型做真实内容校验，本地磁盘与 COS 共用同一份判定，
// 保证 local/cloud 校验口径一致（不做格式重标定：内容与声明类型不符即拒绝）。
// 识别范围与上传白名单（batch3/batch4 init）一致：
//   image/jpeg、image/png；audio/mpeg、audio/aac、audio/mp4(x-m4a)、audio/webm。
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// 返回实际内容的容器类别；无法识别时返回 null（调用方决定是否放行）。
export function detectEvidenceContent(body) {
  if (!Buffer.isBuffer(body) || body.length < 4) return null;
  const isJpeg = body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  if (isJpeg) return "jpeg";
  if (body.length >= 8 && body.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  const isMp3 = body.subarray(0, 3).toString("ascii") === "ID3" || (body[0] === 0xff && (body[1] & 0xe0) === 0xe0);
  if (isMp3) return "mp3";
  const isAac = body[0] === 0xff && (body[1] & 0xf6) === 0xf0;
  if (isAac) return "aac";
  const isMp4 = body.length >= 12 && body.subarray(4, 8).toString("ascii") === "ftyp";
  if (isMp4) return "mp4";
  // WebM/Matroska EBML 魔数（Chrome/Android MediaRecorder 默认容器，batch3 白名单内）。
  const isWebm = body[0] === 0x1a && body[1] === 0x45 && body[2] === 0xdf && body[3] === 0xa3;
  if (isWebm) return "webm";
  return null;
}

const IMAGE_KINDS = new Set(["jpeg", "png"]);
const AUDIO_KINDS = new Set(["mp3", "aac", "mp4", "webm"]);

// 内容与声明类型（image/audio）是否相符；type 非法一律拒绝。
export function isEvidenceContentValid(type, body) {
  const kind = detectEvidenceContent(body);
  if (type === "image") return IMAGE_KINDS.has(kind);
  if (type === "audio") return AUDIO_KINDS.has(kind);
  return false;
}
