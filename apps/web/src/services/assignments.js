// services/assignments.js（module-contracts §3.2；小程序 api.js:66-76 同名同语义）
// 端点映射（registry assignments 组）：
//   getMyAssignments → GET  assignments.mine          （/api/assignments/mine）
//   getAssignment    → GET  assignments.byId(:id)     （/api/assignments/:id）
//   checkIn          → POST assignments.checkIn(:id)  （/api/assignments/:id/check-in）
//   startAssignment  → POST assignments.start(:id)    （/api/assignments/:id/start）
//   getQuestionnaire → GET  assignments.questionnaire(:id)（/api/assignments/:id/questionnaire）
//
// 缓存失效（R09/R10，PM 钉定方案）：模块私有 createAssignmentCache 实例 + epochSeen；
// 每次 getMyAssignments 先读 junde:cache-epoch，与 epochSeen 不同则重建缓存实例。
// login（saveSession 写 epoch）/ logout、401（clearSessionAndUserCache 删 epoch）三处自动失效。
// dedupeKey（R11）：checkin:{id}、start:{id}。
import { request } from "../adapters/http.js";
import { getSession } from "../store/session.js";
import { createAssignmentCache } from "../store/assignments-cache.js";
import { readStorage } from "../adapters/storage.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";

// ---------- 契约校验器（R88，等价小程序 contracts.generated.js 对应断言） ----------
function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response must be an object");
  return value;
}

function assertId(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function assertRevision(value) {
  assertObject(value);
  if (!Number.isInteger(value.revision) || value.revision < 0) throw new Error("response.revision must be a non-negative integer");
  return value;
}

function assertAssignment(value) {
  assertObject(value);
  assertId(value.id, "assignment.id");
  return value;
}

function assertAssignmentList(value) {
  assertObject(value);
  if (!Array.isArray(value.items)) throw new Error("assignment list.items must be an array");
  value.items.forEach(assertAssignment);
  return value;
}

function assertStart(value) {
  assertObject(value);
  assertObject(value.attempt);
  assertId(value.attempt.id, "attempt.id");
  assertRevision(value.attempt);
  assertObject(value.questionnaireVersion);
  assertId(value.questionnaireVersion.id, "questionnaireVersion.id");
  return value;
}

function assertQuestionnaire(value) {
  assertObject(value);
  assertObject(value.attempt);
  assertId(value.attempt.id, "attempt.id");
  assertRevision(value.attempt);
  assertObject(value.questionnaireVersion);
  assertId(value.questionnaireVersion.id, "questionnaireVersion.id");
  if (!Array.isArray(value.questions) || !value.answers || typeof value.answers !== "object" || Array.isArray(value.answers)) throw new Error("questionnaire payload is invalid");
  return value;
}

// ---------- 任务列表短时缓存（R09/R10） ----------
const CACHE_EPOCH_KEY = "junde:cache-epoch";
const EPOCH_UNSEEN = Symbol("cache-epoch-unseen");
let cache = createAssignmentCache();
let epochSeen = EPOCH_UNSEEN;

function syncCacheEpoch() {
  const epoch = readStorage(CACHE_EPOCH_KEY);
  if (epoch !== epochSeen) {
    cache = createAssignmentCache();
    epochSeen = epoch;
  }
}

export function getMyAssignments({ force = false } = {}) {
  syncCacheEpoch();
  const userId = getSession()?.user?.id;
  const cached = cache.get(userId, { force });
  if (cached) return Promise.resolve(cached.items);
  return request({ url: endpointRegistry.assignments.mine.path(), validate: assertAssignmentList }).then((response) => {
    cache.set(userId, response.items);
    return response.items;
  });
}

export function getAssignment(assignmentId) {
  return request({ url: endpointRegistry.assignments.byId.path(assignmentId), validate: assertAssignment });
}

export function checkIn(assignmentId, location) {
  return request({ url: endpointRegistry.assignments.checkIn.path(assignmentId), method: "POST", data: location, dedupeKey: `checkin:${assignmentId}` });
}

export function startAssignment(assignmentId) {
  return request({ url: endpointRegistry.assignments.start.path(assignmentId), method: "POST", validate: assertStart, dedupeKey: `start:${assignmentId}` });
}

export function getQuestionnaire(assignmentId) {
  return request({ url: endpointRegistry.assignments.questionnaire.path(assignmentId), validate: assertQuestionnaire });
}
