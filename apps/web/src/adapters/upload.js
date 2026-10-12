// adapters/upload.js（module-contracts §2.3）
// 平台数据面：文件直传运输层（wx.uploadFile 的 fetch 等价）。
//
// 语义：
// - postFile({ url, fileFieldName, formData, file, onProgress, signal }) → Promise<{ etag }>
// - multipart 直传 file 到服务端下发的预签名 url（R0 唯一例外：运行时数据）；
//   不手设 Content-Type（multipart boundary 由 fetch 运行时生成）。
// - 进度经 onProgress 且钳制 0-100（fetch 无上传进度：开始 1、成功 100，api.js:106 等价）。
// - 成功从响应头取 ETag（大小写双捕，允许 null）；非 2xx / 网络失败 reject
//   （业务文案与分类在 services/uploads.js，运输层不做业务校验）；signal 支持中止。

export function postFile({ url, fileFieldName, formData, file, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    Object.entries(formData || {}).forEach(([key, value]) => body.append(key, value));
    body.append(fileFieldName, file);
    onProgress?.(1);
    // 签名直传目标自证授权（COS POST Policy / 本地签名授权），与业务会话无关：
    // 显式不带 cookie，避免同宿主 Admin 会话 cookie 串入存储端点。
    fetch(url, { method: "POST", body, credentials: "omit", signal })
      .then((response) => {
        if (response.status < 200 || response.status >= 300) {
          const error = new Error("上传请求被拒绝");
          error.statusCode = response.status;
          reject(error);
          return;
        }
        onProgress?.(100);
        resolve({ etag: response.headers.get("ETag") || response.headers.get("etag") || null });
      })
      .catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}
