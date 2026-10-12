import { describe, expect, it } from "vitest";
import { createCosProvider } from "../../apps/api/src/storage/cos.js";

const now = new Date("2026-07-24T00:00:00.000Z");
const configured = {
  COS_REGION: "ap-shanghai", COS_EVIDENCE_BUCKET: "evidence-1250000000", COS_STS_SECRET_ID: "AKID_TEST", COS_STS_SECRET_KEY: "test-secret", COS_STS_TOKEN: "temporary-token", COS_STS_EXPIRES_AT: "2026-07-24T01:00:00.000Z", COS_UPLOAD_TTL_SECONDS: 300, COS_PREVIEW_TTL_SECONDS: 120,
};

describe("private COS post policy", () => {
  it("rejects missing credentials instead of fabricating an upload target", () => {
    const provider = createCosProvider({ COS_UPLOAD_TTL_SECONDS: 300 }, () => now);
    try { provider.createPostTarget({ key: "attempts/a/file", sizeBytes: 1, uploadNonce: "nonce", contentType: "image/jpeg" }); }
    catch (error) { expect(error).toMatchObject({ code: "COS_NOT_CONFIGURED", statusCode: 503 }); return; }
    throw new Error("expected missing COS credentials to reject");
  });

  it("rejects backup writes when the distinct backup bucket is absent", async () => {
    const provider = createCosProvider(configured, () => now);
    await expect(provider.putBackupObject({ key: "postgres/test.dump", body: Buffer.from("x"), contentLength: 1, sha256: "a".repeat(64) })).rejects.toMatchObject({ code: "BACKUP_COS_NOT_CONFIGURED", statusCode: 503 });
  });

  it("signs an exact private object key, byte count, and upload nonce with temporary credentials", () => {
    const provider = createCosProvider(configured, () => now);
    const target = provider.createPostTarget({ key: "attempts/attempt-one/question-evidence/attachment-one/random", sizeBytes: 42, uploadNonce: "nonce-one", contentType: "image/jpeg" });
    const policy = JSON.parse(Buffer.from(target.formData.policy, "base64").toString("utf8"));
    expect(target).toMatchObject({ method: "POST", url: "https://evidence-1250000000.cos.ap-shanghai.myqcloud.com", fileFieldName: "file", expiresAt: "2026-07-24T00:05:00.000Z" });
    expect(policy.conditions).toContainEqual({ key: "attempts/attempt-one/question-evidence/attachment-one/random" });
    expect(policy.conditions).toContainEqual(["content-length-range", 42, 42]);
    expect(policy.conditions).toContainEqual({ "x-cos-meta-upload-nonce": "nonce-one" });
    expect(target.formData).toMatchObject({ "x-cos-security-token": "temporary-token", "q-ak": "AKID_TEST", "q-sign-algorithm": "sha1" });
  });

  it("creates a short-lived HTTPS preview URL without publishing the object", async () => {
    const preview = await createCosProvider(configured, () => now).createPreviewUrl("attempts/attempt-one/question-evidence/attachment-one/random");
    expect(preview.expiresAt).toBe("2026-07-24T00:02:00.000Z");
    expect(preview.url).toContain("https://evidence-1250000000.cos.ap-shanghai.myqcloud.com/");
  });
});
