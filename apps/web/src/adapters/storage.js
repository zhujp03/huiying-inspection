// adapters/storage.js（module-contracts §2.2）
// 平台数据面：存储层。等价 wx.setStorageSync/getStorageSync/removeStorageSync 的全部使用点
// （store/session.js:4-5,9-12,16-20；store/survey.js:11,20,27,36,40）。
//
// 语义：globalThis.localStorage 存在时持久化（JSON 序列化读写），否则以模块内内存 Map 兜底
// （保证 node 测试环境可用）；读不到返回 null。
// 存储键沿用小程序命名：junde:session、junde:draft-index、
// junde:survey:{userId}:{assignmentId}:{attemptId}:{questionnaireVersionId}。

const memoryStorage = new Map();

function localStorageOf() {
  return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
}

export function readStorage(key) {
  const localStorage = localStorageOf();
  if (localStorage) {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }
  const serialized = memoryStorage.get(key);
  return serialized === undefined ? null : JSON.parse(serialized);
}

export function writeStorage(key, value) {
  const serialized = JSON.stringify(value);
  const localStorage = localStorageOf();
  if (localStorage) localStorage.setItem(key, serialized);
  else memoryStorage.set(key, serialized);
}

export function removeStorage(key) {
  const localStorage = localStorageOf();
  if (localStorage) localStorage.removeItem(key);
  else memoryStorage.delete(key);
}
