import http from "k6/http";
import exec from "k6/execution";
import { check, fail, sleep } from "k6";
import { Rate } from "k6/metrics";

const baseUrl = (__ENV.API_BASE_URL || "").replace(/\/$/, "");
const inspectorToken = __ENV.INSPECTOR_TOKEN || "";
const profile = __ENV.P1_PROFILE || "smoke";
const planPath = __ENV.P1_PLAN_PATH || "";
const stageFailures = new Rate("p1_stage_failures");

const profiles = {
  smoke: { executor: "constant-vus", vus: 2, duration: "30s" },
  p1_30rps: { executor: "constant-arrival-rate", rate: 30, timeUnit: "1s", duration: "30m", preAllocatedVUs: 120, maxVUs: 160 },
  p1_100rps: { executor: "constant-arrival-rate", rate: 100, timeUnit: "1s", duration: "60s", preAllocatedVUs: 160, maxVUs: 240 },
  p1_20rps: { executor: "constant-arrival-rate", rate: 20, timeUnit: "1s", duration: "2h", preAllocatedVUs: 120, maxVUs: 140 },
  p1_answer_writes: { executor: "per-vu-iterations", vus: 50, iterations: 1, maxDuration: "2m" },
  p1_submit_burst: { executor: "per-vu-iterations", vus: 30, iterations: 1, maxDuration: "2m" },
  p1_submit_replay: { executor: "per-vu-iterations", vus: 20, iterations: 1, maxDuration: "2m" },
  p1_attachment_complete: { executor: "per-vu-iterations", vus: 20, iterations: 1, maxDuration: "2m" },
  p1_ocr_burst: { executor: "per-vu-iterations", vus: 10, iterations: 1, maxDuration: "2m" },
  p1_campaign_concentrated: { executor: "shared-iterations", vus: 100, iterations: 100, maxDuration: "2m" },
  p1_campaign_publication: { executor: "shared-iterations", vus: 100, iterations: 500, maxDuration: "5m" },
};
const requiresPlan = profile !== "smoke";
const plan = planPath ? JSON.parse(open(planPath)) : null;

export const options = {
  scenarios: { api: { ...(profiles[profile] || profiles.smoke), exec: "runProfile" } },
  thresholds: {
    http_req_failed: ["rate<0.005"],
    "http_req_duration{operation:read}": ["p(95)<500"],
    "http_req_duration{operation:answer_write}": ["p(95)<500"],
    "http_req_duration{operation:submit}": ["p(95)<2000"],
    "http_req_duration{operation:attachment_complete}": ["p(95)<500"],
    "http_req_duration{operation:ocr_enqueue}": ["p(95)<500"],
    "http_req_duration{operation:campaign_mutation}": ["p(95)<500"],
    p1_stage_failures: ["rate==0"],
    checks: ["rate>0.995"],
  },
};

export function setup() {
  if (!profiles[profile]) throw new Error(`Unknown P1_PROFILE: ${profile}`);
  if (!baseUrl) throw new Error("API_BASE_URL is required; this script never creates fixture data.");
  if (/(^|\.)prod(uction)?\./i.test(new URL(baseUrl).hostname) && __ENV.ALLOW_PRODUCTION_LOAD !== "yes") throw new Error("Refusing a production-looking host without ALLOW_PRODUCTION_LOAD=yes.");
  if (requiresPlan && !planPath) throw new Error(`${profile} requires P1_PLAN_PATH; run npm run preflight:p1 first.`);
  if (profile === "smoke" && !inspectorToken && !planPath) throw new Error("smoke requires INSPECTOR_TOKEN or P1_PLAN_PATH");
}

const indexForVu = (items) => items[(exec.vu.idInTest - 1) % items.length];
const indexForIteration = (items) => items[exec.scenario.iterationInTest % items.length];
const inspectorById = (id) => {
  const inspector = plan?.inspectors?.find((item) => item.id === id);
  if (!inspector?.token) fail(`P1 plan has no token for inspector ${id}`);
  return inspector;
};
const adminById = (id) => {
  const admin = plan?.admins?.find((item) => item.id === id);
  if (!admin?.cookie || !admin?.csrfToken) fail(`P1 plan has no session for admin ${id}`);
  return admin;
};
const inspectorParams = (token, operation, expectedStatuses = [200]) => ({
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  tags: { operation }, responseCallback: http.expectedStatuses(...expectedStatuses),
});
const adminParams = (admin, operation, expectedStatuses = [200]) => ({
  headers: { Cookie: admin.cookie, "X-CSRF-Token": admin.csrfToken, "Content-Type": "application/json" },
  tags: { operation }, responseCallback: http.expectedStatuses(...expectedStatuses),
});
const assertResponse = (response, name, statuses) => {
  const success = check(response, { [name]: (item) => statuses.includes(item.status) });
  stageFailures.add(success ? 0 : 1);
  return success;
};
const callAdmin = (entry) => {
  const admin = adminById(entry.adminId);
  const params = adminParams(admin, "campaign_mutation", entry.expectedStatuses || [200]);
  const response = http.request(entry.method, `${baseUrl}${entry.path}`, JSON.stringify(entry.body), params);
  assertResponse(response, "campaign mutation has expected status", entry.expectedStatuses || [200]);
};

const runRead = () => {
  const inspector = plan ? indexForVu(plan.inspectors) : { token: inspectorToken };
  const assignments = http.get(`${baseUrl}/api/assignments/mine`, inspectorParams(inspector.token, "read"));
  assertResponse(assignments, "assignment list is authorized", [200]);
  const assignment = assignments.status === 200 ? assignments.json("items.0") : null;
  if (assignment?.id) {
    const questionnaire = http.get(`${baseUrl}/api/assignments/${assignment.id}/questionnaire`, inspectorParams(inspector.token, "read", [200, 409]));
    assertResponse(questionnaire, "questionnaire has an expected business response", [200, 409]);
  }
  if (plan) {
    const admin = indexForVu(plan.admins);
    const campaigns = http.get(`${baseUrl}/api/admin/campaigns?limit=20`, adminParams(admin, "read"));
    assertResponse(campaigns, "administrator campaign list is authorized", [200]);
  }
  sleep(0.1);
};

const runAnswerWrite = () => {
  const entry = indexForVu(plan.answerWrites);
  const inspector = inspectorById(entry.inspectorId);
  const draft = http.get(`${baseUrl}/api/questionnaires/secret/drafts/${entry.attemptId}`, inspectorParams(inspector.token, "read"));
  if (!assertResponse(draft, "answer write draft is readable", [200])) return;
  const revision = draft.json("attempt.revision");
  const response = http.put(`${baseUrl}/api/questionnaires/secret/drafts/${entry.attemptId}/answers/${entry.questionId}`, JSON.stringify({ answer: "scored", revision }), inspectorParams(inspector.token, "answer_write"));
  assertResponse(response, "answer write succeeds", [200]);
};

const runSubmit = (entry, replay = false) => {
  const inspector = inspectorById(entry.inspectorId);
  const response = http.post(`${baseUrl}/api/questionnaires/secret/${entry.attemptId}/submit`, JSON.stringify({ submitToken: entry.submitToken, assignmentRevision: entry.assignmentRevision, confirmation: true }), inspectorParams(inspector.token, "submit", replay ? [200, 409] : [200]));
  assertResponse(response, replay ? "idempotent replay is accepted or processing" : "prepared submission succeeds", replay ? [200, 409] : [200]);
};

const runAttachmentComplete = () => {
  const entry = indexForVu(plan.attachmentCompletes);
  const inspector = inspectorById(entry.inspectorId);
  const response = http.post(`${baseUrl}/api/questionnaires/secret/drafts/${entry.attemptId}/receipt-attachments/${entry.attachmentId}/complete`, JSON.stringify({ fileMeta: entry.fileMeta, revision: entry.revision }), inspectorParams(inspector.token, "attachment_complete", [200, 202]));
  assertResponse(response, "attachment complete is accepted", [200, 202]);
};

const runOcr = () => {
  const entry = indexForVu(plan.ocrJobs);
  const inspector = inspectorById(entry.inspectorId);
  const response = http.post(`${baseUrl}/api/questionnaires/secret/drafts/${entry.attemptId}/receipt-ocr-jobs`, JSON.stringify({ attachmentIds: entry.attachmentIds, idempotencyKey: entry.idempotencyKey, revision: entry.revision }), inspectorParams(inspector.token, "ocr_enqueue", [200, 201]));
  assertResponse(response, "OCR job is enqueued", [200, 201]);
};

export function runProfile() {
  if (["smoke", "p1_30rps", "p1_100rps", "p1_20rps"].includes(profile)) return runRead();
  if (profile === "p1_answer_writes") return runAnswerWrite();
  if (profile === "p1_submit_burst") return runSubmit(indexForVu(plan.submissions));
  if (profile === "p1_submit_replay") return runSubmit(plan.submitReplay, true);
  if (profile === "p1_attachment_complete") return runAttachmentComplete();
  if (profile === "p1_ocr_burst") return runOcr();
  if (profile === "p1_campaign_concentrated") return callAdmin(indexForIteration(plan.campaign.concentratedRequests));
  return callAdmin(indexForIteration(plan.campaign.publicationRequests));
}
