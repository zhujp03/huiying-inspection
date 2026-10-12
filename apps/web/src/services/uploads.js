// services/uploads.js（module-contracts §3.5；小程序 api.js:97-108 同名同语义）
// uploadToSignedTarget：直传对象存储预签名 URL —— 无 registry 条目（inventory §3.c），
// 目标 url 为服务端运行时下发数据（rules.md R0 唯一例外，不得以字面量进入源码）。
//
// 语义（对照 api.js:97-108）：
// - 参数校验：method !== "POST" 或 url/fileFieldName/formData 缺失或
//   new Date(expiresAt) <= new Date() → 立即 BusinessError("upload", "上传链接已失效，
//   请重新上传")（唯一不可重试 upload 分支），且不发任何请求。
// - 2xx → resolve({ etag })（响应头 ETag|etag 双捕，允许 null）；
//   非 2xx → 「暂时无法上传小票，请重试」（retryable）；
//   网络失败 → 「暂时无法上传小票，请检查网络后重试」（retryable）。
// - 进度钳制 0-100；运输经 adapters/upload.postFile。
import { BusinessError } from "../utils/errors.js";
import { postFile } from "../adapters/upload.js";

export function uploadToSignedTarget({ url, method, fileFieldName, formData, expiresAt }, file, onProgress) {
  return new Promise((resolve, reject) => {
    if (method !== "POST" || !url || !fileFieldName || !formData || new Date(expiresAt) <= new Date()) {
      reject(new BusinessError("upload", "上传链接已失效，请重新上传"));
      return;
    }
    postFile({ url, fileFieldName, formData, file, onProgress })
      .then((result) => resolve(result))
      .catch((error) => {
        reject(
          error?.statusCode !== undefined
            ? new BusinessError("upload", "暂时无法上传小票，请重试", { retryable: true })
            : new BusinessError("upload", "暂时无法上传小票，请检查网络后重试", { retryable: true }),
        );
      });
  });
}
