const requiredString = (value, path) => {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} is required`);
  return value;
};

const arrayAtLeast = (value, path, minimum) => {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${path} must contain at least ${minimum} entries`);
  return value;
};

const unique = (values, path) => {
  if (new Set(values).size !== values.length) throw new Error(`${path} must be unique`);
};

const requireInspector = (entry, path) => {
  requiredString(entry?.id, `${path}.id`);
  requiredString(entry?.token, `${path}.token`);
};

const requireRevision = (value, path) => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${path} must be a non-negative integer`);
};

const requireAdminRequest = (entry, path) => {
  requiredString(entry?.adminId, `${path}.adminId`);
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(entry?.method)) throw new Error(`${path}.method must be POST, PUT, PATCH, or DELETE`);
  const requestPath = requiredString(entry?.path, `${path}.path`);
  if (!requestPath.startsWith("/api/admin/") || requestPath.includes("..")) throw new Error(`${path}.path must be a safe admin API path`);
  if (!entry?.body || typeof entry.body !== "object" || Array.isArray(entry.body)) throw new Error(`${path}.body must be an object`);
  const statuses = entry.expectedStatuses || [200];
  if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some((status) => !Number.isInteger(status) || status < 200 || status > 299)) throw new Error(`${path}.expectedStatuses must contain successful HTTP statuses`);
};

const requireKnown = (known, value, path, kind) => {
  if (!known.has(value)) throw new Error(`${path} must reference a declared ${kind}`);
};

export function validateP1Plan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("P1 plan must be an object");

  const inspectors = arrayAtLeast(plan.inspectors, "inspectors", 100);
  inspectors.forEach((entry, index) => requireInspector(entry, `inspectors[${index}]`));
  unique(inspectors.map((entry) => entry.id), "inspectors[].id");
  const inspectorIds = new Set(inspectors.map((entry) => entry.id));

  const admins = arrayAtLeast(plan.admins, "admins", 20);
  admins.forEach((entry, index) => {
    requiredString(entry?.id, `admins[${index}].id`);
    requiredString(entry?.cookie, `admins[${index}].cookie`);
    requiredString(entry?.csrfToken, `admins[${index}].csrfToken`);
  });
  unique(admins.map((entry) => entry.id), "admins[].id");
  const adminIds = new Set(admins.map((entry) => entry.id));

  const writes = arrayAtLeast(plan.answerWrites, "answerWrites", 50);
  writes.forEach((entry, index) => {
    requiredString(entry?.inspectorId, `answerWrites[${index}].inspectorId`);
    requireKnown(inspectorIds, entry.inspectorId, `answerWrites[${index}].inspectorId`, "inspector");
    requiredString(entry?.attemptId, `answerWrites[${index}].attemptId`);
    requiredString(entry?.questionId, `answerWrites[${index}].questionId`);
  });
  unique(writes.map((entry) => entry.attemptId), "answerWrites[].attemptId");

  const submissions = arrayAtLeast(plan.submissions, "submissions", 30);
  submissions.forEach((entry, index) => {
    requiredString(entry?.inspectorId, `submissions[${index}].inspectorId`);
    requireKnown(inspectorIds, entry.inspectorId, `submissions[${index}].inspectorId`, "inspector");
    requiredString(entry?.attemptId, `submissions[${index}].attemptId`);
    requiredString(entry?.submitToken, `submissions[${index}].submitToken`);
    requireRevision(entry?.assignmentRevision, `submissions[${index}].assignmentRevision`);
  });
  unique(submissions.map((entry) => entry.attemptId), "submissions[].attemptId");

  const replay = plan.submitReplay;
  requiredString(replay?.inspectorId, "submitReplay.inspectorId");
  requireKnown(inspectorIds, replay.inspectorId, "submitReplay.inspectorId", "inspector");
  requiredString(replay?.attemptId, "submitReplay.attemptId");
  requiredString(replay?.submitToken, "submitReplay.submitToken");
  requireRevision(replay?.assignmentRevision, "submitReplay.assignmentRevision");

  const completes = arrayAtLeast(plan.attachmentCompletes, "attachmentCompletes", 20);
  completes.forEach((entry, index) => {
    requiredString(entry?.inspectorId, `attachmentCompletes[${index}].inspectorId`);
    requireKnown(inspectorIds, entry.inspectorId, `attachmentCompletes[${index}].inspectorId`, "inspector");
    requiredString(entry?.attemptId, `attachmentCompletes[${index}].attemptId`);
    requiredString(entry?.attachmentId, `attachmentCompletes[${index}].attachmentId`);
    requireRevision(entry?.revision, `attachmentCompletes[${index}].revision`);
    const fileMeta = entry?.fileMeta;
    if (!fileMeta || typeof fileMeta !== "object" || Array.isArray(fileMeta)) throw new Error(`attachmentCompletes[${index}].fileMeta must be an object`);
    ["clientFileId", "fileName", "mimeType", "sha256"].forEach((field) => requiredString(fileMeta[field], `attachmentCompletes[${index}].fileMeta.${field}`));
    if (!Number.isInteger(fileMeta.sizeBytes) || fileMeta.sizeBytes < 1) throw new Error(`attachmentCompletes[${index}].fileMeta.sizeBytes must be a positive integer`);
  });

  const jobs = arrayAtLeast(plan.ocrJobs, "ocrJobs", 10);
  jobs.forEach((entry, index) => {
    requiredString(entry?.inspectorId, `ocrJobs[${index}].inspectorId`);
    requireKnown(inspectorIds, entry.inspectorId, `ocrJobs[${index}].inspectorId`, "inspector");
    requiredString(entry?.attemptId, `ocrJobs[${index}].attemptId`);
    requiredString(entry?.idempotencyKey, `ocrJobs[${index}].idempotencyKey`);
    requireRevision(entry?.revision, `ocrJobs[${index}].revision`);
    const attachmentIds = arrayAtLeast(entry?.attachmentIds, `ocrJobs[${index}].attachmentIds`, 1);
    if (attachmentIds.length > 3) throw new Error(`ocrJobs[${index}].attachmentIds must contain at most 3 entries`);
    attachmentIds.forEach((id, attachmentIndex) => requiredString(id, `ocrJobs[${index}].attachmentIds[${attachmentIndex}]`));
  });

  const campaign = plan.campaign;
  requiredString(campaign?.id, "campaign.id");
  const concentratedRequests = arrayAtLeast(campaign?.concentratedRequests, "campaign.concentratedRequests", 100);
  concentratedRequests.forEach((entry, index) => {
    const path = `campaign.concentratedRequests[${index}]`;
    requireAdminRequest(entry, path);
    requireKnown(adminIds, entry.adminId, `${path}.adminId`, "administrator");
  });
  const publicationRequests = arrayAtLeast(campaign?.publicationRequests, "campaign.publicationRequests", 500);
  publicationRequests.forEach((entry, index) => {
    const path = `campaign.publicationRequests[${index}]`;
    requireAdminRequest(entry, path);
    requireKnown(adminIds, entry.adminId, `${path}.adminId`, "administrator");
  });

  return Object.freeze({
    inspectors: inspectors.length,
    admins: admins.length,
    answerWrites: writes.length,
    submissions: submissions.length,
    attachmentCompletes: completes.length,
    ocrJobs: jobs.length,
    concentratedRequests: concentratedRequests.length,
    publicationRequests: publicationRequests.length,
  });
}
