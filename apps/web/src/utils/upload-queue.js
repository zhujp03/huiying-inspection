// utils/upload-queue.js（module-contracts §5.6；小程序 pages/dishes/index.js:235-243 内联 Set 抽出）
//
// 语义（R64）：
// - createCancelledUploads() → { has(id), add(id), delete(id), size }
// - 已取消上传 id 集合：add 后 has 恒 true；上传回调命中 has 即放弃回填；
//   显式重试是唯一复活通道（retryUpload 先 delete 再重传）。

export function createCancelledUploads() {
  const ids = new Set();
  return {
    has: (id) => ids.has(id),
    add: (id) => ids.add(id),
    delete: (id) => ids.delete(id),
    get size() {
      return ids.size;
    },
  };
}
