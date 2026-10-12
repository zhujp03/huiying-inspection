// OCR 客户端：按 OCR_PROVIDER 分发，recognize(imageBytes) → lines 的形状对所有 provider 一致
// （lines 元素 = { text, confidence(0–1), boundingBox(数组) }），receipt-ocr.js 的 normalizeLines
// 与解析器不做任何 provider 感知。
//   none    功能关闭：configured=false，recognize 抛 OCR_NOT_CONFIGURED（路由层会提前拦截）
//   tencent 腾讯云通用印刷体识别 GeneralBasicOCR（按量付费；TC3 签名复用 auth/providers.js）
//   paddle  自托管 PaddleOCR sidecar（--profile ocr 逃生舱，原有 fetch 逻辑原样保留）
// 已知限制：腾讯云接口 base64 上限约 7MB，而单附件允许 10MiB——超限图片该 provider 会失败，
// 由探店员手工填写兜底；禁止为此引入图片压缩依赖。
import { tc3Sign } from "../../api/src/auth/providers.js";

const ocrError = (code, message) => Object.assign(new Error(message), { code });

// 腾讯云 API 错误分类：限频/内部错误保留可重试语义（OCR_UNAVAILABLE，worker 按重试延迟再试）；
// 其余（签名失败、图片无效/超限等）映射为终态 OCR_RESPONSE_INVALID，重试无意义。
const retryableTencentOcrError = (code) => /^(InternalError|RequestLimitExceeded|LimitExceeded|Throttling)/.test(String(code));

export function createOcrClient(config) {
  const provider = config.OCR_PROVIDER || "none";
  if (provider === "tencent") {
    const secretId = config.OCR_SECRET_ID;
    const secretKey = config.OCR_SECRET_KEY;
    // 地域默认 ap-shanghai（与 COS 证据桶同地域），可按部署位置覆盖。
    const region = config.OCR_REGION || "ap-shanghai";
    const configured = Boolean(secretId && secretKey);
    return Object.freeze({
      configured,
      async recognize(imageBytes) {
        if (!configured) throw ocrError("OCR_NOT_CONFIGURED", "腾讯云 OCR 服务尚未配置");
        const target = tc3Sign({
          method: "POST", host: "ocr.tencentcloudapi.com", service: "ocr",
          action: "GeneralBasicOCR", version: "2018-11-19", region,
          secretId, secretKey, now: new Date(),
          payload: { ImageBase64: Buffer.from(imageBytes).toString("base64") },
        });
        let response;
        let json = null;
        try {
          response = await fetch(target.url, { method: "POST", headers: target.headers, body: target.body, signal: AbortSignal.timeout(config.OCR_REQUEST_TIMEOUT_MS) });
          json = await response.json().catch(() => null);
        } catch {
          throw ocrError("OCR_UNAVAILABLE", "腾讯云 OCR 服务暂不可用");
        }
        // 响应体不可解析（如网关返回非 JSON）按服务暂不可用处理，保留可重试语义。
        if (!json) throw ocrError("OCR_UNAVAILABLE", "腾讯云 OCR 服务暂不可用");
        const tencentError = json?.Response?.Error;
        if (tencentError?.Code) {
          throw ocrError(retryableTencentOcrError(tencentError.Code) ? "OCR_UNAVAILABLE" : "OCR_RESPONSE_INVALID", "腾讯云 OCR 请求失败");
        }
        if (!response.ok) throw ocrError("OCR_UNAVAILABLE", "腾讯云 OCR 服务暂不可用");
        const detections = json?.Response?.TextDetections;
        if (!Array.isArray(detections)) throw ocrError("OCR_RESPONSE_INVALID", "腾讯云 OCR 响应无效");
        return detections
          .map((item) => ({
            // 空文本行直接丢弃，避免 normalizeLines 对空行抛终态错误。
            text: String(item?.DetectedText || "").trim(),
            // 腾讯置信度 0–100 → 归一化到 0–1，与 paddle 的 lines 语义一致。
            confidence: Math.max(0, Math.min(1, Number(item?.Confidence || 0) / 100)),
            // ItemCoord（X/Y/Width/Height）展开为数字数组，保持 boundingBox 为数组的形状契约。
            boundingBox: item?.ItemCoord ? [Number(item.ItemCoord.X) || 0, Number(item.ItemCoord.Y) || 0, Number(item.ItemCoord.Width) || 0, Number(item.ItemCoord.Height) || 0] : [],
          }))
          .filter((line) => line.text);
      },
    });
  }
  const configured = provider === "paddle" && Boolean(config.OCR_SERVICE_URL);
  return Object.freeze({
    configured,
    async recognize(imageBytes) {
      if (!configured) { const error = new Error("PaddleOCR 服务尚未配置"); error.code = "OCR_NOT_CONFIGURED"; throw error; }
      const response = await fetch(`${config.OCR_SERVICE_URL}/v1/ocr`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: imageBytes, signal: AbortSignal.timeout(config.OCR_REQUEST_TIMEOUT_MS) });
      if (!response.ok) { const error = new Error("PaddleOCR 服务暂不可用"); error.code = "OCR_UNAVAILABLE"; throw error; }
      const body = await response.json();
      if (!Array.isArray(body.lines)) { const error = new Error("PaddleOCR 响应无效"); error.code = "OCR_RESPONSE_INVALID"; throw error; }
      return body.lines;
    },
  });
}
