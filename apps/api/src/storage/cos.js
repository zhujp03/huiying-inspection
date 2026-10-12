// 私有 COS 凭证与对象操作。
//
// 凭证来源支持两种模式：
//   1. static：COS_STS_SECRET_ID/SECRET_KEY/TOKEN/EXPIRES_AT 一次性注入（测试/一次性
//      运维使用；过期后不可续期，直接返回可重试 503）。
//   2. renewing：COS_ROLE_ARN + COS_ASSUME_ROLE_SECRET_ID/KEY 通过 CAM AssumeRole 获取
//      最小权限临时凭证；凭证在过期前自动续期，并发刷新单飞合并，刷新失败返回 503。
//
// 所有网络刷新只发生在 assertReady()（路由在开启数据库事务前调用）；持有数据库锁的
// 事务内绝不发起外部网络调用。createPostTarget 使用已缓存的当前凭证做纯本地签名。
import { createHmac, createHash, randomBytes } from "node:crypto";
import COS from "cos-nodejs-sdk-v5";
import { isEvidenceContentValid } from "./content-type.js";

const hmacSha1 = (key, value) => createHmac("sha1", key).update(value).digest("hex");
const hmacSha256 = (key, value) => createHmac("sha256", key).update(value).digest();
const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
const privateBucketUrl = (bucket, region) => `https://${bucket}.cos.${region}.myqcloud.com`;

const cosError = (code, message, statusCode = 503, retryable = true) => Object.assign(new Error(message), { code, statusCode, retryable });

// --- 可续期凭证 Provider ----------------------------------------------------
export function createCosCredentialProvider(config, clock = () => new Date(), logger = console) {
  const staticConfigured = Boolean(config.COS_STS_SECRET_ID && config.COS_STS_SECRET_KEY && config.COS_STS_TOKEN && config.COS_STS_EXPIRES_AT);
  const roleConfigured = Boolean(config.COS_ROLE_ARN && config.COS_ASSUME_ROLE_SECRET_ID && config.COS_ASSUME_ROLE_SECRET_KEY);
  if (!staticConfigured && !roleConfigured) return null;

  if (staticConfigured) {
    return Object.freeze({
      mode: "static",
      async getCredentials() {
        const expiresAt = new Date(config.COS_STS_EXPIRES_AT);
        if (expiresAt <= clock()) throw cosError("COS_CREDENTIALS_EXPIRED", "私有文件服务凭据已过期且无法续期", 503, true);
        return { secretId: config.COS_STS_SECRET_ID, secretKey: config.COS_STS_SECRET_KEY, token: config.COS_STS_TOKEN, expiresAt };
      },
      async refresh() { await this.getCredentials(); },
      // 同步读取（createPostTarget 在事务内做纯本地签名时使用）。
      peekCredentials() {
        const expiresAt = new Date(config.COS_STS_EXPIRES_AT);
        if (expiresAt <= clock()) throw cosError("COS_CREDENTIALS_EXPIRED", "私有文件服务凭据已过期且无法续期", 503, true);
        return { secretId: config.COS_STS_SECRET_ID, secretKey: config.COS_STS_SECRET_KEY, token: config.COS_STS_TOKEN, expiresAt };
      },
    });
  }

  // renewing：CAM AssumeRole（最小权限角色），单飞刷新 + 过期前自动续期。
  const durationSeconds = Math.min(7200, Math.max(900, Number(config.COS_STS_DURATION_SECONDS || 3600)));
  const refreshBeforeSeconds = Math.min(durationSeconds / 2, Math.max(60, Number(config.COS_STS_REFRESH_BEFORE_SECONDS || 300)));
  const host = "sts.tencentcloudapi.com";
  let cached = null;
  let refreshing = null;
  const assumeRole = async () => {
    const timestamp = Math.floor(clock().getTime() / 1000);
    const date = new Date(clock()).toISOString().slice(0, 10);
    const payload = JSON.stringify({ RoleArn: config.COS_ROLE_ARN, RoleSessionName: `junde-cos-${randomBytes(8).toString("hex")}`, DurationSeconds: durationSeconds });
    const canonicalRequest = ["POST", "/", "", `content-type:application/json; charset=utf-8\nhost:${host}\n`, "content-type;host", sha256Hex(payload)].join("\n");
    const credentialScope = `${date}/sts/tc3_request`;
    const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const secretDate = hmacSha256(`TC3${config.COS_ASSUME_ROLE_SECRET_KEY}`, date);
    const secretSigning = hmacSha256(hmacSha256(secretDate, "sts"), "tc3_request");
    const signature = hmacSha256(secretSigning, stringToSign).toString("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(config.COS_STS_TIMEOUT_MS || 8000));
    try {
      const response = await fetch(`https://${host}`, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8", host,
          "x-tc-action": "AssumeRole", "x-tc-version": "2018-08-13", "x-tc-timestamp": String(timestamp),
          authorization: `TC3-HMAC-SHA256 Credential=${config.COS_ASSUME_ROLE_SECRET_ID}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`,
        },
        body: payload, signal: controller.signal,
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      if (!response.ok || !json?.Response?.Credentials?.TmpSecretId) {
        const message = json?.Response?.Error?.Message || `sts http ${response.status}`;
        throw cosError("COS_CREDENTIAL_REFRESH_FAILED", `COS 凭证续期失败：${message}`, 503, true);
      }
      const credentials = json.Response.Credentials;
      const expiresAt = new Date(Number(json.Response.ExpiredTime || (timestamp + durationSeconds)) * 1000);
      cached = { secretId: credentials.TmpSecretId, secretKey: credentials.TmpSecretKey, token: credentials.Token, expiresAt };
      logger.info?.({ mode: "renewing", expiresAt: expiresAt.toISOString() }, "COS credentials refreshed");
      return cached;
    } catch (error) {
      if (error?.name === "AbortError") throw cosError("COS_CREDENTIAL_REFRESH_TIMEOUT", "COS 凭证续期超时", 503, true);
      if (error?.code && error?.statusCode) throw error;
      throw cosError("COS_CREDENTIAL_REFRESH_FAILED", "COS 凭证续期失败", 503, true);
    } finally {
      clearTimeout(timer);
    }
  };
  const refresh = async () => {
    if (!refreshing) refreshing = assumeRole().finally(() => { refreshing = null; });
    return refreshing;
  };
  return Object.freeze({
    mode: "renewing",
    async getCredentials() {
      if (cached && clock().getTime() + refreshBeforeSeconds * 1000 < cached.expiresAt.getTime()) return cached;
      // 续期失败但旧凭证仍有效：继续使用旧凭证，让下一次调用重试续期。
      try { return await refresh(); }
      catch (error) {
        if (cached && cached.expiresAt > clock()) return cached;
        throw error;
      }
    },
    async refresh() { await refresh(); },
    peekCredentials() {
      if (!cached) throw cosError("COS_CREDENTIALS_NOT_READY", "私有文件服务凭据尚未就绪", 503, true);
      if (cached.expiresAt <= clock()) throw cosError("COS_CREDENTIALS_EXPIRED", "私有文件服务凭据已过期", 503, true);
      return cached;
    },
  });
}

export function createCosProvider(config, clock = () => new Date(), logger = console) {
  const provider = createCosCredentialProvider(config, clock, logger);
  const clientConfigured = Boolean(config.COS_REGION && provider);
  const configured = Boolean(clientConfigured && config.COS_EVIDENCE_BUCKET);
  const exportConfigured = Boolean(clientConfigured && config.COS_EXPORT_BUCKET);
  const backupConfigured = Boolean(clientConfigured && config.COS_BACKUP_BUCKET);
  const assertConfigured = () => {
    if (!configured) throw cosError("COS_NOT_CONFIGURED", "私有文件服务尚未配置", 503, true);
  };
  // 路由在开启数据库事务前调用，确保证券网络刷新发生在锁外。
  const assertReady = async () => { assertConfigured(); await provider.getCredentials(); };
  const assertExportConfigured = async () => {
    if (!exportConfigured) throw cosError("EXPORT_COS_NOT_CONFIGURED", "导出文件服务尚未配置", 503, true);
    await provider.getCredentials();
  };
  const assertBackupConfigured = async () => {
    if (!backupConfigured) throw cosError("BACKUP_COS_NOT_CONFIGURED", "备份文件服务尚未配置", 503, true);
    await provider.getCredentials();
  };
  const clients = new Map();
  const call = async (method, params) => {
    const credentials = await provider.getCredentials();
    const key = `${credentials.secretId}:${sha256Hex(credentials.token)}`;
    let client = clients.get(key);
    if (!client) {
      client = new COS({ SecretId: credentials.secretId, SecretKey: credentials.secretKey, SecurityToken: credentials.token });
      clients.set(key, client);
    }
    return new Promise((resolve, reject) => client[method](params, (error, data) => error ? reject(error) : resolve(data)));
  };
  const createPostTarget = ({ key, sizeBytes, uploadNonce, contentType }) => {
    assertConfigured();
    const credentials = provider.peekCredentials();
    const now = clock();
    const uploadTtlMs = Math.max(60, Math.min(300, Number(config.COS_UPLOAD_TTL_SECONDS || 300))) * 1000;
    const expiresAt = new Date(Math.min(now.getTime() + uploadTtlMs, credentials.expiresAt.getTime()));
    if (expiresAt <= now || Number.isNaN(expiresAt.getTime())) throw cosError("COS_CREDENTIALS_EXPIRED", "私有文件服务凭据已过期", 503, true);
    const keyTime = `${Math.floor(now.getTime() / 1000)};${Math.floor(expiresAt.getTime() / 1000)}`;
    const policy = {
      expiration: expiresAt.toISOString(),
      conditions: [
        { bucket: config.COS_EVIDENCE_BUCKET }, { key }, { "x-cos-meta-upload-nonce": uploadNonce }, { "x-cos-meta-declared-content-type": contentType },
        ["content-length-range", sizeBytes, sizeBytes], { "q-sign-algorithm": "sha1" }, { "q-ak": credentials.secretId }, { "q-sign-time": keyTime },
      ],
    };
    const encodedPolicy = Buffer.from(JSON.stringify(policy)).toString("base64");
    const signKey = hmacSha1(credentials.secretKey, keyTime);
    const signature = hmacSha1(signKey, createHash("sha1").update(JSON.stringify(policy)).digest("hex"));
    return {
      method: "POST", url: privateBucketUrl(config.COS_EVIDENCE_BUCKET, config.COS_REGION), fileFieldName: "file", headers: {}, expiresAt: expiresAt.toISOString(),
      formData: { key, policy: encodedPolicy, "q-sign-algorithm": "sha1", "q-ak": credentials.secretId, "q-key-time": keyTime, "q-signature": signature, "x-cos-security-token": credentials.token, "x-cos-meta-upload-nonce": uploadNonce, "x-cos-meta-declared-content-type": contentType, success_action_status: "204" },
    };
  };
  const verifyObject = async ({ key, uploadNonce, expectedSizeBytes, type, declaredContentType }) => {
    assertConfigured();
    const params = { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key };
    const head = await call("headObject", params);
    const headers = Object.fromEntries(Object.entries(head.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    const sizeBytes = Number(headers["content-length"]);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== expectedSizeBytes) throw Object.assign(new Error("对象大小不匹配"), { code: "EVIDENCE_FILE_INVALID", statusCode: 422 });
    if (headers["x-cos-meta-upload-nonce"] !== uploadNonce) throw Object.assign(new Error("对象上传凭据不匹配"), { code: "EVIDENCE_UPLOAD_INVALID", statusCode: 422 });
    const downloaded = await call("getObject", params);
    const body = Buffer.isBuffer(downloaded.Body) ? downloaded.Body : Buffer.from(downloaded.Body || "");
    // 魔数闸与本地磁盘形态共用同一份判定（storage/content-type.js）：含 audio/webm（EBML），
    // 与上传白名单及 batch3 的 webm 等价校验口径一致，不做格式重标定。
    if (!isEvidenceContentValid(type, body)) throw Object.assign(new Error("文件内容与声明类型不符"), { code: "EVIDENCE_FILE_INVALID", statusCode: 422 });
    const sha256 = createHash("sha256").update(body).digest("hex");
    return { sizeBytes, mimeType: declaredContentType, sha256, storageVersionId: headers["x-cos-version-id"] || null, durationSeconds: null };
  };
  const createPreviewUrl = async (key) => {
    assertConfigured();
    const credentials = await provider.getCredentials();
    const now = clock();
    const expiresAt = new Date(Math.min(now.getTime() + config.COS_PREVIEW_TTL_SECONDS * 1000, credentials.expiresAt.getTime()));
    if (expiresAt <= now) throw cosError("COS_CREDENTIALS_EXPIRED", "私有文件服务凭据已过期", 503, true);
    const data = await call("getObjectUrl", { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key, Sign: true, Protocol: "https:", Method: "GET", Expires: Math.floor((expiresAt.getTime() - now.getTime()) / 1000), Query: { "response-content-disposition": "inline" } });
    return { url: data.Url, expiresAt: expiresAt.toISOString() };
  };
  const deleteObject = async (key) => {
    assertConfigured();
    try { await call("deleteObject", { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key }); }
    catch (error) { if (![404, "NoSuchKey", "NoSuchBucket"].includes(error.statusCode || error.code)) throw error; }
  };
  const readObject = async (key) => {
    assertConfigured();
    const object = await call("getObject", { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key });
    return Buffer.isBuffer(object.Body) ? object.Body : Buffer.from(object.Body || "");
  };
  const verifyStoredObject = async ({ key, storageVersionId = null, expectedSizeBytes, expectedSha256 }) => {
    assertConfigured();
    const params = { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key, ...(storageVersionId ? { VersionId: storageVersionId } : {}) };
    const head = await call("headObject", params);
    const headers = Object.fromEntries(Object.entries(head.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    const sizeBytes = Number(headers["content-length"]);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes !== expectedSizeBytes) throw Object.assign(new Error("对象大小不匹配"), { code: "OBJECT_SIZE_MISMATCH" });
    const downloaded = await call("getObject", params);
    const body = Buffer.isBuffer(downloaded.Body) ? downloaded.Body : Buffer.from(downloaded.Body || "");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== expectedSha256) throw Object.assign(new Error("对象校验和不匹配"), { code: "OBJECT_SHA256_MISMATCH" });
    return { sizeBytes, sha256, storageVersionId: headers["x-cos-version-id"] || null };
  };
  const requestArchiveRestore = async ({ key, storageVersionId = null }) => {
    assertConfigured();
    await call("restoreObject", { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key, ...(storageVersionId ? { VersionId: storageVersionId } : {}), RestoreRequest: { Days: 1, Tier: "Standard" } });
  };
  const archiveRestoreStatus = async ({ key, storageVersionId = null }) => {
    assertConfigured();
    const object = await call("headObject", { Bucket: config.COS_EVIDENCE_BUCKET, Region: config.COS_REGION, Key: key, ...(storageVersionId ? { VersionId: storageVersionId } : {}) });
    const headers = Object.fromEntries(Object.entries(object.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    const restore = headers["x-cos-restore"] || "";
    if (/ongoing-request\s*=\s*["']?true/i.test(restore)) return { status: "restoring", expiresAt: null };
    const expiry = restore.match(/expiry-date\s*=\s*["']?([^,"']+)/i)?.[1];
    return { status: "ready", expiresAt: expiry ? new Date(expiry).toISOString() : null };
  };
  const putExportObject = async ({ key, body, contentType = "text/csv; charset=utf-8" }) => {
    await assertExportConfigured();
    await call("putObject", { Bucket: config.COS_EXPORT_BUCKET, Region: config.COS_REGION, Key: key, Body: body, ContentType: contentType });
  };
  const deleteExportObject = async (key) => {
    await assertExportConfigured();
    try { await call("deleteObject", { Bucket: config.COS_EXPORT_BUCKET, Region: config.COS_REGION, Key: key }); }
    catch (error) { if (![404, "NoSuchKey", "NoSuchBucket"].includes(error.statusCode || error.code)) throw error; }
  };
  const createExportDownloadUrl = async (key) => {
    await assertExportConfigured();
    const credentials = await provider.getCredentials();
    const now = clock(); const expiresAt = new Date(Math.min(now.getTime() + config.COS_PREVIEW_TTL_SECONDS * 1000, credentials.expiresAt.getTime()));
    const data = await call("getObjectUrl", { Bucket: config.COS_EXPORT_BUCKET, Region: config.COS_REGION, Key: key, Sign: true, Protocol: "https:", Method: "GET", Expires: Math.floor((expiresAt.getTime() - now.getTime()) / 1000), Query: { "response-content-disposition": "attachment" } });
    return { url: data.Url, expiresAt: expiresAt.toISOString() };
  };
  const putBackupObject = async ({ key, body, contentLength, sha256 }) => {
    await assertBackupConfigured();
    await call("putObject", { Bucket: config.COS_BACKUP_BUCKET, Region: config.COS_REGION, Key: key, Body: body, ContentLength: contentLength, ContentType: "application/octet-stream", "x-cos-meta-sha256": sha256 });
  };
  const headBackupObject = async (key) => {
    await assertBackupConfigured();
    const object = await call("headObject", { Bucket: config.COS_BACKUP_BUCKET, Region: config.COS_REGION, Key: key });
    const headers = Object.fromEntries(Object.entries(object.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
    return { sizeBytes: Number(headers["content-length"]), sha256: headers["x-cos-meta-sha256"] || null, versionId: headers["x-cos-version-id"] || null };
  };
  return Object.freeze({ configured, exportConfigured, backupConfigured, assertConfigured, assertReady, createPostTarget, verifyObject, createPreviewUrl, deleteObject, readObject, verifyStoredObject, requestArchiveRestore, archiveRestoreStatus, putExportObject, deleteExportObject, createExportDownloadUrl, putBackupObject, headBackupObject, newObjectSuffix: () => randomBytes(16).toString("hex") });
}
