// 本地磁盘存储（STORAGE_PROVIDER=local）单元/契约测试：
// 签名授权的签发与验证、multipart 直传落盘、大小/nonce/魔数校验、路径逃逸拒绝、
// 过期/篡改授权拒绝、预览与导出下载、重启持久化、幂等删除、导出清理、生产拒绝。
// 不依赖数据库：路由层行为全部经 buildApp + app.inject 驱动（pool=null 时不触库）。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../../apps/api/src/app.js";
import { loadConfig } from "../../apps/api/src/config.js";
import { createStorageProvider } from "../../apps/api/src/storage/index.js";
import { assertSafeKey, MAX_LOCAL_EVIDENCE_BYTES, objectGrantSignature } from "../../apps/api/src/storage/local.js";

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(61, 0x11)]);
const PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(56, 0x22)]);
// 与 PNG_BYTES 同长不同内容的合法 PNG（写一次性重放保护测试用）。
const PNG_BYTES_ALT = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(56, 0x99)]);
// 最小 EBML 头（WebM/Matroska）：Chrome MediaRecorder 的真实录音都以此开头。
const WEBM_BYTES = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60, 0x33)]);
const MP3_BYTES = Buffer.concat([Buffer.from("ID3", "ascii"), Buffer.alloc(61, 0x44)]);

let root = "";
const signingKey = "unit-local-signing-key-unit-local-signing-key";

const localEnv = (extra = {}) => ({
  NODE_ENV: "test", STORAGE_PROVIDER: "local", LOCAL_STORAGE_DIR: root,
  AUTH_TOKEN_HMAC_KEY: signingKey, PUBLIC_API_ORIGIN: "http://127.0.0.1:3000",
  OCR_PROVIDER: "none", ...extra,
});

const multipartParts = (fields, file, boundary) => {
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
};

const uploadRequest = async (app, grant, file, overrides = {}) => {
  const boundary = "----jundelocalstorage";
  const fields = { ...grant.formData, ...overrides };
  const body = multipartParts(fields, file, boundary);
  return app.inject({
    method: "POST", url: "/api/local-storage/objects",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
};

describe.sequential("local storage provider", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "junde-local-storage-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("defaults to the COS provider and selects local only for STORAGE_PROVIDER=local", () => {
    const cosProvider = createStorageProvider(loadConfig({ NODE_ENV: "test" }));
    expect(cosProvider.configured).toBe(false);
    expect(typeof cosProvider.putBackupObject).toBe("function");
    const local = createStorageProvider(loadConfig(localEnv()));
    expect(local.configured).toBe(true);
    expect(local.exportConfigured).toBe(true);
    expect(local.backupConfigured).toBe(false);
    expect(local.localStorageRoot).toBe(path.resolve(root));
  });

  it("production rejects local storage before any other production validation", () => {
    expect(() => loadConfig(localEnv({ NODE_ENV: "production" }))).toThrow(/STORAGE_PROVIDER=local/);
  });

  it("completes a real upload: signed POST -> bytes on disk -> verification", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const key = `attempts/attempt-1/question-evidence/11111111-1111-7111-8111-111111111111/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: JPEG_BYTES.length, uploadNonce: "nonce-upload-1", contentType: "image/jpeg" });
    expect(target.method).toBe("POST");
    expect(new URL(target.url).pathname).toBe("/api/local-storage/objects");
    expect(target.fileFieldName).toBe("file");
    expect(new Date(target.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const response = await uploadRequest(app, target, { filename: "evidence.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
    expect(response.statusCode, response.body).toBe(204);
    const jpegSha256 = createHash("sha256").update(JPEG_BYTES).digest("hex");
    expect(response.headers.etag).toBe(`"${jpegSha256}"`);
    const stored = await readFile(path.join(root, key));
    expect(stored.equals(JPEG_BYTES)).toBe(true);
    const verified = await provider.verifyObject({ key, uploadNonce: "nonce-upload-1", expectedSizeBytes: JPEG_BYTES.length, type: "image", declaredContentType: "image/jpeg" });
    expect(verified.sizeBytes).toBe(JPEG_BYTES.length);
    expect(verified.sha256).toBe(jpegSha256);
    expect(verified.storageVersionId).toBeNull();
    await app.close();
  });

  it("rejects tampered, malformed and expired grants", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const key = `attempts/attempt-1/question-evidence/22222222-2222-7222-8222-222222222222/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: JPEG_BYTES.length, uploadNonce: "nonce-upload-2", contentType: "image/jpeg" });

    const tampered = await uploadRequest(app, target, { filename: "e.jpg", contentType: "image/jpeg", data: JPEG_BYTES }, { signature: `${target.formData.signature.slice(0, -2)}xx` });
    expect(tampered.statusCode).toBe(403);
    expect(tampered.json().error.code).toBe("STORAGE_GRANT_INVALID");

    const noSignature = await uploadRequest(app, target, { filename: "e.jpg", contentType: "image/jpeg", data: JPEG_BYTES }, { signature: "" });
    expect(noSignature.statusCode).toBe(403);

    // 真实签名但已过期：手工构造过期授权。
    const expiredGrant = { operation: "upload", key, nonce: "nonce-upload-2", size: String(JPEG_BYTES.length), contentType: "image/jpeg", expires: "1" };
    const expired = await uploadRequest(app, { ...target, formData: { ...expiredGrant, signature: objectGrantSignature(config, expiredGrant) } }, { filename: "e.jpg", contentType: "image/jpeg", data: JPEG_BYTES });
    expect(expired.statusCode).toBe(403);
    expect(expired.json().error.code).toBe("STORAGE_GRANT_EXPIRED");

    // GET 侧同样拒绝。
    const preview = await provider.createPreviewUrl("attempts/attempt-1/question-evidence/22222222-2222-7222-8222-222222222222/missing");
    const url = new URL(preview.url);
    url.searchParams.set("signature", `${url.searchParams.get("signature")}x`);
    const badGet = await app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
    expect(badGet.statusCode).toBe(403);
    const noSigGet = await app.inject({ method: "GET", url: url.pathname });
    expect(noSigGet.statusCode).toBe(403);
    await app.close();
  });

  it("rejects uploads whose byte count disagrees with the signed grant", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const key = `attempts/attempt-1/question-evidence/33333333-3333-7333-8333-333333333333/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: JPEG_BYTES.length, uploadNonce: "nonce-upload-3", contentType: "image/jpeg" });

    const shortBody = await uploadRequest(app, target, { filename: "e.jpg", contentType: "image/jpeg", data: JPEG_BYTES.subarray(0, 10) });
    expect(shortBody.statusCode).toBe(422);
    expect(shortBody.json().error.code).toBe("STORAGE_UPLOAD_SIZE_MISMATCH");

    const oversized = await uploadRequest(app, target, { filename: "e.jpg", contentType: "image/jpeg", data: Buffer.concat([JPEG_BYTES, Buffer.alloc(32, 0)]) });
    expect(oversized.statusCode).toBe(413);
    await expect(stat(path.join(root, key))).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

  it("blocks path traversal in provider keys and in signed requests", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    expect(() => provider.createPostTarget({ key: "attempts/../secrets/x", sizeBytes: 5, uploadNonce: "n", contentType: "image/jpeg" })).toThrow();
    await expect(provider.deleteObject("../../etc/passwd")).rejects.toMatchObject({ code: "STORAGE_KEY_INVALID" });
    await expect(provider.readObject("attempts/a/../../../etc/passwd")).rejects.toMatchObject({ code: "STORAGE_KEY_INVALID" });
    expect(() => assertSafeKey(root, "exports/../../escape", ["exports/"])).toThrow();
    // 逃逸 key 即使拼进查询串也过不了签名/子树双闸。
    const response = await app.inject({ method: "GET", url: "/api/local-storage/objects?operation=preview&key=attempts/..%2F..%2F.env&expires=9999999999&signature=AAAA" });
    expect([403, 400]).toContain(response.statusCode);
    await app.close();
  });

  it("verifies real content: webm/mp3 audio pass, mismatched or garbage content fails", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const put = async (suffix, nonce, data, contentType) => {
      const key = `attempts/attempt-1/question-evidence/44444444-4444-7444-8444-444444444444/${suffix}`;
      const target = provider.createPostTarget({ key, sizeBytes: data.length, uploadNonce: nonce, contentType });
      const response = await uploadRequest(app, target, { filename: "f", contentType, data });
      expect(response.statusCode, response.body).toBe(204);
      return key;
    };
    const webmKey = await put(provider.newObjectSuffix(), "nonce-webm", WEBM_BYTES, "audio/webm");
    const verifiedWebm = await provider.verifyObject({ key: webmKey, uploadNonce: "nonce-webm", expectedSizeBytes: WEBM_BYTES.length, type: "audio", declaredContentType: "audio/webm" });
    expect(verifiedWebm.sizeBytes).toBe(WEBM_BYTES.length);
    const mp3Key = await put(provider.newObjectSuffix(), "nonce-mp3", MP3_BYTES, "audio/mpeg");
    await expect(provider.verifyObject({ key: mp3Key, uploadNonce: "nonce-mp3", expectedSizeBytes: MP3_BYTES.length, type: "audio", declaredContentType: "audio/mpeg" })).resolves.toMatchObject({ sizeBytes: MP3_BYTES.length });
    // WebM 内容声明成 image：拒绝（不重标定格式）。
    const mislabeled = await put(provider.newObjectSuffix(), "nonce-bad", WEBM_BYTES, "image/jpeg");
    await expect(provider.verifyObject({ key: mislabeled, uploadNonce: "nonce-bad", expectedSizeBytes: WEBM_BYTES.length, type: "image", declaredContentType: "image/jpeg" })).rejects.toMatchObject({ code: "EVIDENCE_FILE_INVALID", statusCode: 422 });
    // 纯垃圾内容：拒绝。
    const garbage = await put(provider.newObjectSuffix(), "nonce-garbage", Buffer.alloc(64, 0x5a), "image/png");
    await expect(provider.verifyObject({ key: garbage, uploadNonce: "nonce-garbage", expectedSizeBytes: 64, type: "image", declaredContentType: "image/png" })).rejects.toMatchObject({ code: "EVIDENCE_FILE_INVALID" });
    // nonce 不匹配：拒绝（等价 COS x-cos-meta-upload-nonce 复核）。
    await expect(provider.verifyObject({ key: webmKey, uploadNonce: "wrong-nonce", expectedSizeBytes: WEBM_BYTES.length, type: "audio", declaredContentType: "audio/webm" })).rejects.toMatchObject({ code: "EVIDENCE_UPLOAD_INVALID", statusCode: 422 });
    await app.close();
  });

  it("serves preview downloads through signed GET grants only", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const key = `attempts/attempt-1/question-evidence/55555555-5555-7555-8555-555555555555/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: PNG_BYTES.length, uploadNonce: "nonce-preview", contentType: "image/png" });
    expect((await uploadRequest(app, target, { filename: "p.png", contentType: "image/png", data: PNG_BYTES })).statusCode).toBe(204);

    const preview = await provider.createPreviewUrl(key);
    expect(new URL(preview.url).searchParams.get("operation")).toBe("preview");
    const response = await app.inject({ method: "GET", url: new URL(preview.url).pathname + new URL(preview.url).search });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-disposition"]).toBe("inline");
    expect(response.rawPayload.equals(PNG_BYTES)).toBe(true);
    expect(new Date(preview.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // 无授权读取不存在于 COS 形态之外的旁路：缺对象 404，缺授权 403。
    const missingPreview = await provider.createPreviewUrl("attempts/attempt-1/question-evidence/55555555-5555-7555-8555-555555555555/nope");
    const missing = await app.inject({ method: "GET", url: new URL(missingPreview.url).pathname + new URL(missingPreview.url).search });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("STORAGE_OBJECT_MISSING");
    await app.close();
  });

  it("persists objects across provider restarts and verifies stored bytes", async () => {
    const config = loadConfig(localEnv());
    const provider = createStorageProvider(config);
    const key = `attempts/attempt-1/question-evidence/66666666-6666-7666-8666-666666666666/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: JPEG_BYTES.length, uploadNonce: "nonce-restart", contentType: "image/jpeg" });
    const app = buildApp({ config, pool: null, logger: false });
    expect((await uploadRequest(app, target, { filename: "r.jpg", contentType: "image/jpeg", data: JPEG_BYTES })).statusCode).toBe(204);
    await app.close();

    // 「重启」：全新 provider 实例（等价新进程）读同一目录。
    const restarted = createStorageProvider(loadConfig(localEnv()));
    const reread = await restarted.readObject(key);
    expect(reread.equals(JPEG_BYTES)).toBe(true);
    const sha256 = createHash("sha256").update(JPEG_BYTES).digest("hex");
    await expect(restarted.verifyStoredObject({ key, expectedSizeBytes: JPEG_BYTES.length, expectedSha256: sha256 })).resolves.toMatchObject({ sizeBytes: JPEG_BYTES.length });
    await expect(restarted.verifyStoredObject({ key, expectedSizeBytes: JPEG_BYTES.length, expectedSha256: "f".repeat(64) })).rejects.toMatchObject({ code: "OBJECT_SHA256_MISMATCH" });
  });

  it("deletes exactly the intended object, idempotently", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const keyA = `attempts/attempt-1/question-evidence/77777777-7777-7777-8777-777777777777/${provider.newObjectSuffix()}`;
    const targetA = provider.createPostTarget({ key: keyA, sizeBytes: JPEG_BYTES.length, uploadNonce: "nonce-del-a", contentType: "image/jpeg" });
    expect((await uploadRequest(app, targetA, { filename: "a.jpg", contentType: "image/jpeg", data: JPEG_BYTES })).statusCode).toBe(204);
    await provider.deleteObject(keyA);
    await expect(provider.deleteObject(keyA)).resolves.toBeUndefined();
    await expect(stat(path.join(root, keyA))).rejects.toMatchObject({ code: "ENOENT" });
    const previewA = await provider.createPreviewUrl(keyA);
    const gone = await app.inject({ method: "GET", url: new URL(previewA.url).pathname + new URL(previewA.url).search });
    expect(gone.statusCode).toBe(404);
    await app.close();
  });

  it("writes, downloads and cleans real export files", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const csv = Buffer.from("﻿提交时间,任务\n2026-10-12T00:00:00.000Z,示例任务\n", "utf8");
    const key = "exports/job-1/worker-1.csv";
    await provider.putExportObject({ key, body: csv, contentType: "text/csv; charset=utf-8" });
    const download = await provider.createExportDownloadUrl(key);
    const response = await app.inject({ method: "GET", url: new URL(download.url).pathname + new URL(download.url).search });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.rawPayload.equals(csv)).toBe(true);
    // download 授权也可读证据树（管理员回看附件），但 preview 授权不能读导出树。
    await expect(provider.createPreviewUrl("exports/job-1/worker-1.csv")).rejects.toMatchObject({ code: "STORAGE_KEY_INVALID" });
    await provider.deleteExportObject(key);
    await expect(provider.deleteExportObject(key)).resolves.toBeUndefined();
    await expect(stat(path.join(root, key))).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });

  it("answers archive restores honestly and refuses backup uploads in local mode", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    const key = `attempts/attempt-1/question-evidence/88888888-8888-7888-8888-888888888888/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: JPEG_BYTES.length, uploadNonce: "nonce-archive", contentType: "image/jpeg" });
    expect((await uploadRequest(app, target, { filename: "ar.jpg", contentType: "image/jpeg", data: JPEG_BYTES })).statusCode).toBe(204);
    await expect(provider.requestArchiveRestore({ key })).resolves.toBeUndefined();
    await expect(provider.archiveRestoreStatus({ key })).resolves.toMatchObject({ status: "ready" });
    await expect(provider.requestArchiveRestore({ key: "attempts/attempt-1/question-evidence/88888888-8888-7888-8888-888888888888/missing" })).rejects.toMatchObject({ code: "ARCHIVE_OBJECT_MISSING", statusCode: 404 });
    await expect(provider.putBackupObject({ key: "postgres/x.dump", body: Buffer.from("x"), contentLength: 1, sha256: "a".repeat(64) })).rejects.toMatchObject({ code: "BACKUP_LOCAL_NOT_AVAILABLE", statusCode: 503 });
    await expect(provider.headBackupObject("postgres/x.dump")).rejects.toMatchObject({ code: "BACKUP_LOCAL_NOT_AVAILABLE" });
    await app.close();
  });

  it("scopes the larger body limit to the signed upload route only", async () => {
    const config = loadConfig(localEnv());
    const app = buildApp({ config, pool: null, logger: false });
    const provider = createStorageProvider(config);
    // 1.2MiB（超过应用默认 1MiB）：证明放宽只发生在签名路由。
    const bigPng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(Math.floor(1.2 * 1024 * 1024), 0x77)]);
    const key = `attempts/attempt-1/question-evidence/99999999-9999-7999-8999-999999999999/${provider.newObjectSuffix()}`;
    const target = provider.createPostTarget({ key, sizeBytes: bigPng.length, uploadNonce: "nonce-big", contentType: "image/png" });
    const ok = await uploadRequest(app, target, { filename: "big.png", contentType: "image/png", data: bigPng });
    expect(ok.statusCode, ok.body).toBe(204);
    expect((await stat(path.join(root, key))).size).toBe(bigPng.length);
    // 契约上限 10MiB 由「授权精确字节数 + busboy fileSize」共同强制：授权已顶满 10MiB 时
    // 哪怕只多 1 个字节也在流式读取阶段被 413 拒绝（授权签发本身限制 size≤10MiB）。
    const boundary = "----jundelimit";
    const hugeGrant = provider.createPostTarget({ key: "attempts/attempt-1/question-evidence/99999999-9999-7999-8999-999999999999/extra", sizeBytes: MAX_LOCAL_EVIDENCE_BYTES, uploadNonce: "nonce-huge", contentType: "image/png" });
    const extra = await uploadRequest(app, hugeGrant, { filename: "huge.png", contentType: "image/png", data: Buffer.alloc(MAX_LOCAL_EVIDENCE_BYTES + 1, 0x88) });
    expect(extra.statusCode).toBe(413);
    expect(["STORAGE_UPLOAD_TOO_LARGE", "STORAGE_UPLOAD_SIZE_MISMATCH"]).toContain(extra.json().error.code);
    await expect(stat(path.join(root, "attempts/attempt-1/question-evidence/99999999-9999-7999-8999-999999999999/extra"))).rejects.toMatchObject({ code: "ENOENT" });
    // 非法授权的大请求在读取内容之前就被拒绝（先验签后读流，不缓冲 body）。
    const body = multipartParts({ x: "1" }, { filename: "huge.bin", contentType: "application/octet-stream", data: Buffer.alloc(1024, 0x88) }, boundary);
    const rejected = await app.inject({ method: "POST", url: "/api/local-storage/objects", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(rejected.statusCode).toBe(403);
    // 应用其余接口未受影响。
    expect((await app.inject({ method: "GET", url: "/live" })).statusCode).toBe(200);
    await app.close();
  });
});

// 写一次性重放保护：同一签名授权重放绝不覆盖已存对象（已校验/已提交的原始证据不可变）。
describe.sequential("local storage write-once replay protection", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "junde-local-replay-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const replayKey = () => `attempts/attempt-r/question-evidence/aaaaaaa1-0000-7000-8000-000000000001/${createHash("md5").update(String(Math.random())).digest("hex")}`;
  const makeGrant = (key, sizeBytes) => createStorageProvider(loadConfig(localEnv())).createPostTarget({ key, sizeBytes, uploadNonce: `nonce-${key.slice(-8)}`, contentType: "image/png" });

  it("treats identical replay as idempotent and never rewrites the original", async () => {
    let app = buildApp({ config: loadConfig(localEnv()), pool: null, logger: false });
    const key = replayKey();
    const grant = makeGrant(key, PNG_BYTES.length);
    const first = await uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES });
    expect(first.statusCode, first.body).toBe(204);
    const before = await readFile(path.join(root, key));

    const replay = await uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES });
    expect(replay.statusCode, replay.body).toBe(204);
    expect(replay.headers.etag).toBe(first.headers.etag);
    expect((await readFile(path.join(root, key))).equals(before)).toBe(true);
    await app.close();

    // 跨 provider 重启（全新进程等价）后同样幂等。
    app = buildApp({ config: loadConfig(localEnv()), pool: null, logger: false });
    const replayAfterRestart = await uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES });
    expect(replayAfterRestart.statusCode).toBe(204);
    expect((await readFile(path.join(root, key))).equals(before)).toBe(true);
    await app.close();
  });

  it("rejects changed bytes on replay with 409 and leaves the original untouched", async () => {
    let app = buildApp({ config: loadConfig(localEnv()), pool: null, logger: false });
    const key = replayKey();
    const grant = makeGrant(key, PNG_BYTES.length);
    expect((await uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES })).statusCode).toBe(204);
    const provider = createStorageProvider(loadConfig(localEnv()));
    const originalSha = (await provider.verifyObject({ key, uploadNonce: grant.formData.nonce, expectedSizeBytes: PNG_BYTES.length, type: "image", declaredContentType: "image/png" })).sha256;

    // 同一有效授权 + 同长度不同内容：409，磁盘对象逐字节不变（含跨重启的 provider 实例）。
    app = buildApp({ config: loadConfig(localEnv()), pool: null, logger: false });
    const replay = await uploadRequest(app, grant, { filename: "b.png", contentType: "image/png", data: PNG_BYTES_ALT });
    expect(replay.statusCode, replay.body).toBe(409);
    expect(replay.json().error.code).toBe("STORAGE_OBJECT_EXISTS");
    const after = await readFile(path.join(root, key));
    expect(after.equals(PNG_BYTES)).toBe(true);
    expect(createHash("sha256").update(after).digest("hex")).toBe(originalSha);
    // 元数据（sha256）也未被动过：verifyObject 仍以原内容通过。
    await expect(provider.verifyObject({ key, uploadNonce: grant.formData.nonce, expectedSizeBytes: PNG_BYTES.length, type: "image", declaredContentType: "image/png" })).resolves.toMatchObject({ sha256: originalSha });
    // 临时目录无残片。
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
    await app.close();
  });

  it("handles concurrent identical and conflicting replays race-safely", async () => {
    const app = buildApp({ config: loadConfig(localEnv()), pool: null, logger: false });
    const key = replayKey();
    const grant = makeGrant(key, PNG_BYTES.length);
    // 并发同内容：全部 204，最终磁盘内容正确。
    const identical = await Promise.all([
      uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES }),
      uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES }),
      uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES }),
    ]);
    expect(identical.map((response) => response.statusCode)).toEqual([204, 204, 204]);
    expect((await readFile(path.join(root, key))).equals(PNG_BYTES)).toBe(true);
    // 并发异内容：恰一个 204 胜出（同字节请求按幂等成功），其余 409，磁盘对象为胜出字节。
    const race = await Promise.all([
      uploadRequest(app, grant, { filename: "a.png", contentType: "image/png", data: PNG_BYTES }),
      uploadRequest(app, grant, { filename: "b.png", contentType: "image/png", data: PNG_BYTES_ALT }),
      uploadRequest(app, grant, { filename: "c.png", contentType: "image/png", data: PNG_BYTES_ALT }),
    ]);
    const statuses = race.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([204, 409, 409]);
    const winner = race.find((response) => response.statusCode === 204);
    const winnerSha = winner.headers.etag.replace(/"/g, "");
    const disk = await readFile(path.join(root, key));
    expect(createHash("sha256").update(disk).digest("hex")).toBe(winnerSha);
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(path.join(root, "tmp"))).toEqual([]);
    await app.close();
  });

  it("rejects a valid signed multipart request without a file with 400", async () => {
    const app = buildApp({ config: loadConfig(localEnv()), pool: null, logger: false });
    const key = replayKey();
    const grant = makeGrant(key, PNG_BYTES.length);
    const body = multipartParts(grant.formData, null, "----jundereplay");
    const response = await app.inject({ method: "POST", url: "/api/local-storage/objects", headers: { "content-type": "multipart/form-data; boundary=----jundereplay" }, payload: body });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("STORAGE_UPLOAD_INVALID");
    await expect(stat(path.join(root, key))).rejects.toMatchObject({ code: "ENOENT" });
    await app.close();
  });
});

// 挂载父目录就绪语义（assertReady）：
//   - 开发/测试：允许在既有可写祖先下递归创建深层根目录；
//   - 生产（render）：挂载父目录固定 /var/data，必须已由平台挂载，缺失即失败关闭，
//     绝不从 / 开始凭空造挂载层级；创建后做 realpath 包含复核。
describe.sequential("local storage mount-parent readiness", () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "junde-local-mount-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates deep roots under an existing writable ancestor without creating mounts from /", async () => {
    const deepRoot = path.join(root, "mount", "leaf", "storage");
    const provider = createStorageProvider(loadConfig(localEnv({ LOCAL_STORAGE_DIR: deepRoot })));
    await expect(provider.assertReady()).resolves.toBeUndefined();
    await expect(stat(path.join(deepRoot, "tmp"))).resolves.toBeTruthy();
    // 可写探针在挂载父目录生效过：根目录与 tmp 均真实存在。
    expect(existsSync(deepRoot)).toBe(true);
  });

  it("production render mount parent /var/data missing fails closed before any creation", async () => {
    const productionEnv = localEnv({
      NODE_ENV: "production", DEPLOYMENT_TARGET: "render", LOCAL_STORAGE_DIR: "/var/data/storage",
      PUBLIC_API_ORIGIN: undefined, MINIAPP_API_BASE_URL: undefined,
      RENDER_EXTERNAL_URL: "https://junde-app.onrender.com", OCR_PROVIDER: "none", AUTH_SELF_SERVICE: "disabled",
      PHONE_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 8).toString("base64"),
      TENCENT_MAP_KEY: "mount-test-map-key-0123456789", DATABASE_URL: "postgresql://u:p@db.internal:5432/junde",
    });
    const provider = createStorageProvider(loadConfig(productionEnv));
    if (existsSync("/var/data")) {
      // 挂载点存在的机器（Render/容器）上本用例不适用：显式跳过而非假通过。
      console.warn("skipping: /var/data exists on this machine; mount-missing path not exercisable");
      return;
    }
    await expect(provider.assertReady()).rejects.toMatchObject({ code: "LOCAL_STORAGE_MOUNT_MISSING" });
    expect(existsSync("/var/data")).toBe(false); // 绝不从 / 递归造挂载点
  });
});
