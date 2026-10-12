import { describe, expect, it } from "vitest";
import { validateP1Plan } from "../load/p1-plan.mjs";

const ids = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
const plan = () => ({
  inspectors: ids("inspector", 100).map((id) => ({ id, token: `token-${id}` })),
  admins: ids("admin", 20).map((id) => ({ id, cookie: `cookie-${id}`, csrfToken: `csrf-${id}` })),
  answerWrites: ids("answer", 50).map((attemptId, index) => ({ inspectorId: `inspector-${index}`, attemptId, questionId: `question-${index}` })),
  submissions: ids("submission", 30).map((attemptId, index) => ({ inspectorId: `inspector-${index}`, attemptId, submitToken: `submit-${index}`, assignmentRevision: 1 })),
  submitReplay: { inspectorId: "inspector-0", attemptId: "replay-attempt", submitToken: "replay-token", assignmentRevision: 1 },
  attachmentCompletes: ids("attachment", 20).map((attachmentId, index) => ({ inspectorId: `inspector-${index}`, attemptId: `complete-attempt-${index}`, attachmentId, revision: 1, fileMeta: { clientFileId: `client-${index}`, fileName: "receipt.jpg", mimeType: "image/jpeg", sizeBytes: 1, sha256: "a".repeat(64) } })),
  ocrJobs: ids("ocr", 10).map((id, index) => ({ inspectorId: `inspector-${index}`, attemptId: `ocr-attempt-${index}`, attachmentIds: [`${id}-1`, `${id}-2`], idempotencyKey: `ocr-key-${index}`, revision: 1 })),
  campaign: { id: "campaign-1", concentratedRequests: ids("concentrated", 100).map((id) => ({ adminId: "admin-0", method: "PATCH", path: `/api/admin/assignments/${id}`, body: { revision: 1 } })), publicationRequests: ids("publication", 500).map((id) => ({ adminId: "admin-0", method: "POST", path: `/api/admin/campaigns/${id}/cancel`, body: { revision: 1 } })) },
});

describe("P1 staging plan", () => {
  it("requires the full authorized P1 data shape without leaking its contents", () => {
    expect(validateP1Plan(plan())).toMatchObject({ inspectors: 100, admins: 20, answerWrites: 50, submissions: 30, attachmentCompletes: 20, ocrJobs: 10, concentratedRequests: 100, publicationRequests: 500 });
  });

  it("rejects an undersized plan", () => {
    const invalid = plan();
    invalid.inspectors.pop();
    expect(() => validateP1Plan(invalid)).toThrow("inspectors must contain at least 100 entries");
  });

  it("rejects an incomplete COS complete payload and unsafe administrator path", () => {
    const missingFileMeta = plan();
    delete missingFileMeta.attachmentCompletes[0].fileMeta;
    expect(() => validateP1Plan(missingFileMeta)).toThrow("attachmentCompletes[0].fileMeta must be an object");

    const unsafeAdminPath = plan();
    unsafeAdminPath.campaign.concentratedRequests[0].path = "/api/questionnaires/secret/drafts/unsafe";
    expect(() => validateP1Plan(unsafeAdminPath)).toThrow("campaign.concentratedRequests[0].path must be a safe admin API path");

    const unknownIdentity = plan();
    unknownIdentity.ocrJobs[0].inspectorId = "missing-inspector";
    expect(() => validateP1Plan(unknownIdentity)).toThrow("ocrJobs[0].inspectorId must reference a declared inspector");
  });
});
