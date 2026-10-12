import { expect, request as playwrightRequest, test } from "@playwright/test";
import { ReceiptAttachmentListSchema, ReceiptAttachmentMutationSchema, ReceiptOcrApplySchema, ReceiptOcrJobSchema, ReceiptUploadInitSchema } from "../../packages/contracts/index.js";

const contractOrigin = `http://127.0.0.1:${Number(process.env.CONTRACT_PORT || 8787)}`;
const authorization = { Authorization: "Bearer test-access-token" };
const draftPath = "/api/questionnaires/secret/drafts/attempt-one";

test("receipt fixture covers upload retry, OCR terminal states, idempotent apply, conflict and deletion choices", async () => {
  const client = await playwrightRequest.newContext({ baseURL: contractOrigin, extraHTTPHeaders: authorization });
  try {
    let response = await client.get(`${draftPath}/receipt-attachments`);
    let list = ReceiptAttachmentListSchema.parse(await response.json());
    let revision = list.revision;

    response = await client.post(`${draftPath}/receipt-attachments/uploads`, { data: { fileMeta: { clientFileId: "018f9484-ac49-7003-bb4c-3b1d45117640", fileName: "fail-once.jpg", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, revision } });
    expect(response.status()).toBe(201);
    const initialized = ReceiptUploadInitSchema.parse(await response.json());
    revision = initialized.revision;

    response = await client.post(initialized.uploadTarget.url, { data: "fixture image bytes", headers: initialized.uploadTarget.formData });
    expect(response.status()).toBe(503);
    response = await client.post(initialized.uploadTarget.url, { data: "fixture image bytes", headers: initialized.uploadTarget.headers });
    expect(response.status()).toBe(204);

    response = await client.post(`${draftPath}/receipt-attachments/${initialized.attachment.id}/complete`, { data: { fileMeta: { fileName: "fail-once.jpg", mimeType: "image/jpeg", sizeBytes: 2048, etag: "fixture-etag" }, revision } });
    const completed = ReceiptAttachmentMutationSchema.parse(await response.json());
    expect(completed.attachment.status).toBe("ready");
    revision = completed.revision;

    const createJob = async (idempotencyKey) => {
      const createdResponse = await client.post(`${draftPath}/receipt-ocr-jobs`, { data: { attachmentIds: [initialized.attachment.id], idempotencyKey, revision } });
      expect(createdResponse.status()).toBe(201);
      return ReceiptOcrJobSchema.parse(await createdResponse.json());
    };
    const finishJob = async (job) => {
      ReceiptOcrJobSchema.parse(await (await client.get(`${draftPath}/receipt-ocr-jobs/${job.id}`)).json());
      return ReceiptOcrJobSchema.parse(await (await client.get(`${draftPath}/receipt-ocr-jobs/${job.id}`)).json());
    };

    let job = await createJob("fixture-success");
    job = await finishJob(job);
    expect(job.status).toBe("succeeded");
    response = await client.post(`${draftPath}/receipt-ocr-jobs/${job.id}/apply`, { data: { idempotencyKey: "fixture-apply-once", revision } });
    const applied = ReceiptOcrApplySchema.parse(await response.json());
    revision = applied.revision;
    const repeated = ReceiptOcrApplySchema.parse(await (await client.post(`${draftPath}/receipt-ocr-jobs/${job.id}/apply`, { data: { idempotencyKey: "fixture-apply-once", revision: revision - 1 } })).json());
    expect(repeated.dishes).toHaveLength(applied.dishes.length);
    expect(repeated.revision).toBe(applied.revision);

    job = await createJob("fixture-partial");
    job = await finishJob(job);
    expect(job.status).toBe("partial");
    response = await client.post(`${draftPath}/receipt-ocr-jobs/${job.id}/apply`, { data: { idempotencyKey: "fixture-conflict", revision: revision - 1 } });
    expect(response.status()).toBe(409);
    response = await client.post(`${draftPath}/receipt-ocr-jobs/${job.id}/apply`, { data: { idempotencyKey: "fixture-partial-apply", revision } });
    const partialApplied = ReceiptOcrApplySchema.parse(await response.json());
    expect(partialApplied.dishes.some((dish) => dish.reviewFields.includes("unitPriceCents"))).toBe(true);
    revision = partialApplied.revision;

    job = await createJob("fixture-failed");
    job = await finishJob(job);
    expect(job.status).toBe("failed");

    response = await client.delete(`${draftPath}/receipt-attachments/receipt-one`, { data: { dishHandling: "keep_as_manual", revision } });
    let deleted = ReceiptAttachmentMutationSchema.parse(await response.json());
    expect(deleted.dishes.filter((dish) => dish.source === "manual").length).toBeGreaterThan(0);
    revision = deleted.revision;
    response = await client.delete(`${draftPath}/receipt-attachments/${initialized.attachment.id}`, { data: { dishHandling: "remove_unmodified_ocr_rows", revision } });
    deleted = ReceiptAttachmentMutationSchema.parse(await response.json());
    revision = deleted.revision;
    response = await client.delete(`${draftPath}/receipt-attachments/receipt-failed`, { data: { dishHandling: "keep_as_manual", revision } });
    deleted = ReceiptAttachmentMutationSchema.parse(await response.json());
    revision = deleted.revision;

    for (let index = 0; index < 9; index += 1) {
      response = await client.post(`${draftPath}/receipt-attachments/uploads`, { data: { fileMeta: { clientFileId: `limit-${index}`, fileName: `${index}.jpg`, mimeType: "image/jpeg", sizeBytes: 1000 }, revision } });
      const item = ReceiptUploadInitSchema.parse(await response.json());
      revision = item.revision;
    }
    response = await client.post(`${draftPath}/receipt-attachments/uploads`, { data: { fileMeta: { clientFileId: "limit-tenth", fileName: "tenth.jpg", mimeType: "image/jpeg", sizeBytes: 1000 }, revision } });
    expect(response.status()).toBe(422);
    expect((await response.json()).error.code).toBe("RECEIPT_LIMIT_EXCEEDED");
  } finally { await client.dispose(); }
});
