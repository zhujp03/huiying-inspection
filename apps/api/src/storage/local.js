// 本地磁盘存储 Provider（STORAGE_PROVIDER=local，仅 development/test）。
//
// 与私有 COS Provider 完全同构：证据对象走「签名直传 + 服务端完成校验」，导出对象走
// worker 写入 + 签名下载；业务路由（batch3/batch4/batch5/worker）不改调用方式。
// 形态差异：
//   - COS POST Policy → HMAC 签名授权（createPostTarget 返回本地 API 的 multipart 端点，
//     formData 即授权字段；路由 apps/api/src/storage/routes.js 验签后落盘）。
//   - x-cos-meta-* 对象元数据 → 磁盘元数据旁车 meta/<key>.json（nonce/contentType/大小）。
//   - 预签名 GET → 指向同一端点的短期签名查询串（inline 预览 / attachment 下载）。
// 磁盘布局（LOCAL_STORAGE_DIR，相对路径以仓库根解析，API 与 worker 必须同一目录）：
//   <root>/attempts/...   证据对象（题目证据 + 消费小票）
//   <root>/exports/...    导出文件（worker 写入）
//   <root>/meta/<key>.json 对象元数据旁车
//   <root>/tmp/           上传中的临时文件（同分区 rename 保证原子落盘）
// 备份能力（putBackupObject/headBackupObject）在本地形态显式不可用：绝不伪造备份结果。
// 归档恢复（requestArchiveRestore/archiveRestoreStatus）如实回答：本地对象永远处于热态，
// 文件存在即 ready、缺失即报错，不模拟 COS 归档层。
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { isEvidenceContentValid } from "./content-type.js";

// 业务白名单内的附件上限（packages/contracts sizeBytes max 10MiB）。
export const MAX_LOCAL_EVIDENCE_BYTES = 10 * 1024 * 1024;
const EVIDENCE_PREFIX = "attempts/";
const EXPORT_PREFIX = "exports/";
const GRANT_PURPOSE = "junde-local-storage-grants-v1";
// key 只允许 ASCII 安全字符（无反斜杠/控制字符），拒绝 ".."，并要求解析后落在根内。
const KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9/._-]{0,500}$/;

const storageError = (code, message, statusCode = 500, retryable = false) => Object.assign(new Error(message), { code, statusCode, retryable });
const invalidKey = () => storageError("STORAGE_KEY_INVALID", "存储对象标识不合法", 400);
const missingObject = () => storageError("STORAGE_OBJECT_MISSING", "存储对象不存在或已删除", 404);
const grantInvalid = (message = "存储访问授权无效") => storageError("STORAGE_GRANT_INVALID", message, 403);
const grantExpired = () => storageError("STORAGE_GRANT_EXPIRED", "存储访问授权已过期", 403);

const ttlMs = (value, fallback) => Math.max(60, Math.min(3600, Number(value || fallback))) * 1000;
const epochSeconds = (date) => Math.floor(date.getTime() / 1000);

// 本地形态对外 URL 的服务端来源：优先 PUBLIC_API_ORIGIN（可配置，非硬编码前端域）；
// 未配置时按 HOST/PORT 推导（0.0.0.0/:: 换成回环地址保证可拨号），保持本地默认回环。
export function localPublicOrigin(config) {
  if (config.PUBLIC_API_ORIGIN) return String(config.PUBLIC_API_ORIGIN).replace(/\/+$/, "");
  const host = ["", "0.0.0.0", "::"].includes(String(config.HOST || "")) ? "127.0.0.1" : config.HOST;
  return `http://${host}:${config.PORT}`;
}

export function resolveLocalStorageRoot(config) {
  const configured = String(config.LOCAL_STORAGE_DIR || ".local-storage").trim() || ".local-storage";
  return path.resolve(process.cwd(), configured);
}

// 签名密钥：由既有 AUTH_TOKEN_HMAC_KEY 经用途分隔派生（purpose separation），
// 与会话/盲索引用途隔离；本地形态不引入新的必配密钥。
const grantSecret = (config) => {
  const key = config.AUTH_TOKEN_HMAC_KEY;
  if (!key || String(key).length < 32) throw storageError("LOCAL_STORAGE_SIGNING_KEY_MISSING", "本地存储签名需要配置 AUTH_TOKEN_HMAC_KEY（32 字符以上）", 500);
  return createHmac("sha256", String(key)).update(GRANT_PURPOSE).digest();
};

const grantPayload = (grant) => {
  if (grant.operation === "upload") return `upload|${grant.key}|${grant.nonce}|${grant.size}|${grant.contentType}|${grant.expires}`;
  return `${grant.operation}|${grant.key}|${grant.expires}`;
};

export const objectGrantSignature = (config, grant) => createHmac("sha256", grantSecret(config)).update(grantPayload(grant)).digest("base64url");

// 验签 + 归一化授权：operation 绑定 key 子树（upload/preview 仅证据树；download 另允许导出树），
// 过期、篡改、路径逃逸都在这里失败关闭。upload 授权额外绑定 nonce/精确字节数/声明类型。
export function verifyObjectGrant(config, grant, clock = () => new Date()) {
  if (!grant || typeof grant !== "object") throw grantInvalid();
  const operation = grant.operation;
  if (!["upload", "preview", "download"].includes(operation)) throw grantInvalid();
  const expires = Number(grant.expires);
  if (!Number.isSafeInteger(expires) || `${grant.expires}`.trim() !== `${expires}`) throw grantInvalid();
  if (expires <= epochSeconds(clock())) throw grantExpired();
  if (typeof grant.signature !== "string" || !grant.signature) throw grantInvalid();
  const expected = objectGrantSignature(config, { ...normalizeGrantKeyFields(grant), operation, expires: String(expires) });
  const actual = Buffer.from(grant.signature);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) throw grantInvalid();
  if (operation === "upload") {
    const size = Number(grant.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_LOCAL_EVIDENCE_BYTES) throw grantInvalid("上传授权大小不合法");
    return { operation, key: grant.key, nonce: String(grant.nonce || ""), size, contentType: String(grant.contentType || ""), expires };
  }
  return { operation, key: grant.key, expires };
}

const normalizeGrantKeyFields = (grant) => {
  const base = { key: grant.key, expires: String(grant.expires) };
  if (grant.operation === "upload") return { ...base, nonce: String(grant.nonce || ""), size: String(grant.size), contentType: String(grant.contentType || "") };
  return base;
};

// key 安全解析：模式匹配 + 拒绝 ".." + 解析结果必须落在 root 的子树内（防路径逃逸）。
export function assertSafeKey(root, key, prefixes) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key) || key.includes("..")) throw invalidKey();
  if (Array.isArray(prefixes) ? !prefixes.some((prefix) => key.startsWith(prefix)) : !key.startsWith(prefixes)) throw invalidKey();
  const resolved = path.resolve(root, key);
  const rootWithSep = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootWithSep)) throw invalidKey();
  return resolved;
}

const readMeta = async (metaPath) => {
  try {
    return JSON.parse(await readFile(metaPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

export function createLocalStorageProvider(config, clock = () => new Date(), logger = console) {
  // 与 config.js 生产门同源的双重保险：生产环境只有在显式 DEPLOYMENT_TARGET=render 时才允许
  // 本地磁盘存储；决策键一致，绕过 loadConfig 直接构造 Provider 也无法放开生产禁令。
  if (config.NODE_ENV === "production" && config.DEPLOYMENT_TARGET !== "render") {
    throw storageError("LOCAL_STORAGE_PRODUCTION_FORBIDDEN", "生产环境禁止本地磁盘存储；唯一例外是显式 DEPLOYMENT_TARGET=render 部署目标", 500);
  }
  const root = resolveLocalStorageRoot(config);
  const origin = localPublicOrigin(config);
  const uploadTtl = ttlMs(config.LOCAL_UPLOAD_TTL_SECONDS, 300);
  const previewTtl = ttlMs(config.LOCAL_PREVIEW_TTL_SECONDS, 300);
  const objectPath = (key, prefixes) => assertSafeKey(root, key, prefixes);
  const metaPath = (key) => path.join(root, "meta", `${key}.json`);
  const tmpPath = () => path.join(root, "tmp", `upload-${randomBytes(12).toString("hex")}.part`);

  const configured = true;
  const assertConfigured = () => {
    // 本地形态恒配置；保留与 COS Provider 同构的失败关闭入口（防御未来配置化改动）。
    if (!root) throw storageError("LOCAL_STORAGE_NOT_CONFIGURED", "本地文件存储尚未配置", 503, true);
  };
  // 路由在开启数据库事务前调用（HTTP 就绪之前也由 server/start-render 预检）：
  // 1) 先定位「已存在的挂载父目录」——生产 render 形态固定为 /var/data（config.js 已把根目录
  //    规范化约束在其下），绝不从 / 开始递归 mkdir 凭空造挂载点；开发/测试回退到首个已存在祖先。
  // 2) 挂载父目录必须可写（写入探针），缺失/只读直接失败关闭。
  // 3) 递归创建根目录后做 realpath 包含复核：父目录被符号链接调包导致的逃逸在此失败。
  const assertReady = async () => {
    assertConfigured();
    let mountParent;
    if (config.NODE_ENV === "production") {
      // 生产（render 目标唯一合法）：持久磁盘挂载点必须已由平台挂载好。
      mountParent = "/var/data";
      if (!existsSync(mountParent)) throw storageError("LOCAL_STORAGE_MOUNT_MISSING", `本地存储挂载父目录不存在：${mountParent}（持久磁盘未挂载？）`, 500);
    } else {
      mountParent = root;
      while (mountParent !== path.dirname(mountParent) && !existsSync(mountParent)) mountParent = path.dirname(mountParent);
      if (!existsSync(mountParent)) throw storageError("LOCAL_STORAGE_MOUNT_MISSING", `本地存储挂载父目录不存在：${mountParent}`, 500);
    }
    const mountProbe = path.join(mountParent, `.mount-probe-${process.pid}`);
    await writeFile(mountProbe, String(clock().getTime()));
    await rm(mountProbe, { force: true });
    await mkdir(root, { recursive: true });
    await mkdir(path.join(root, "tmp"), { recursive: true });
    // realpath 包含复核：root 经真实路径解析后必须仍落在挂载父目录之下（防符号链接调包逃逸）。
    const [realRoot, realMount] = await Promise.all([realpath(root), realpath(mountParent)]);
    const realMountWithSep = realMount.endsWith(path.sep) ? realMount : realMount + path.sep;
    if (realRoot !== realMount && !realRoot.startsWith(realMountWithSep)) {
      throw storageError("LOCAL_STORAGE_ROOT_ESCAPED", "本地存储根目录解析后不在挂载父目录之内（疑似符号链接逃逸）", 500);
    }
    const probe = path.join(root, `.ready-probe-${process.pid}`);
    await writeFile(probe, String(clock().getTime()));
    await rm(probe, { force: true });
  };

  // 签名直传目标：与 COS POST Policy 同形（POST multipart + formData 字段 + expiresAt），
  // H5 fetch FormData 与小程序 wx.uploadFile 无需并行业务流。
  const createPostTarget = ({ key, sizeBytes, uploadNonce, contentType }) => {
    assertConfigured();
    objectPath(key, [EVIDENCE_PREFIX]);
    const size = Number(sizeBytes);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_LOCAL_EVIDENCE_BYTES) throw storageError("LOCAL_UPLOAD_SIZE_INVALID", "上传大小不合法", 422);
    if (!uploadNonce || typeof uploadNonce !== "string") throw storageError("LOCAL_UPLOAD_NONCE_INVALID", "上传凭据不合法", 422);
    const declaredContentType = String(contentType || "");
    if (!declaredContentType) throw storageError("LOCAL_UPLOAD_CONTENT_TYPE_INVALID", "上传类型声明缺失", 422);
    const now = clock();
    const expires = String(epochSeconds(new Date(now.getTime() + uploadTtl)));
    const grant = { operation: "upload", key, nonce: uploadNonce, size: String(size), contentType: declaredContentType, expires };
    return {
      method: "POST", url: `${origin}/api/local-storage/objects`, fileFieldName: "file", headers: {},
      expiresAt: new Date(Number(expires) * 1000).toISOString(),
      formData: { key, nonce: uploadNonce, size: String(size), contentType: declaredContentType, expires, signature: objectGrantSignature(config, grant) },
    };
  };

  // 上传后完成校验：nonce 旁车复核（等价 COS x-cos-meta-upload-nonce）、精确大小、真实魔数、sha256。
  const verifyObject = async ({ key, uploadNonce, expectedSizeBytes, type, declaredContentType }) => {
    assertConfigured();
    const filePath = objectPath(key, [EVIDENCE_PREFIX]);
    const meta = await readMeta(metaPath(key));
    if (!meta) throw storageError("EVIDENCE_FILE_INVALID", "文件内容与声明类型不符", 422);
    if (meta.uploadNonce !== uploadNonce) throw storageError("EVIDENCE_UPLOAD_INVALID", "对象上传凭据不匹配", 422);
    let body;
    try {
      body = await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw storageError("EVIDENCE_FILE_INVALID", "文件内容与声明类型不符", 422);
      throw error;
    }
    const expectedSize = Number(expectedSizeBytes);
    if (!Number.isSafeInteger(body.length) || body.length !== expectedSize) throw storageError("EVIDENCE_FILE_INVALID", "对象大小不匹配", 422);
    if (!isEvidenceContentValid(type, body)) throw storageError("EVIDENCE_FILE_INVALID", "文件内容与声明类型不符", 422);
    const sha256 = createHash("sha256").update(body).digest("hex");
    return { sizeBytes: body.length, mimeType: declaredContentType, sha256, storageVersionId: null, durationSeconds: null };
  };

  const signedReadUrl = async (key, operation, prefixes) => {
    assertConfigured();
    objectPath(key, prefixes);
    const now = clock();
    const expires = String(epochSeconds(new Date(now.getTime() + previewTtl)));
    const grant = { operation, key, expires };
    const url = new URL(`${origin}/api/local-storage/objects`);
    url.searchParams.set("operation", operation);
    url.searchParams.set("key", key);
    url.searchParams.set("expires", expires);
    url.searchParams.set("signature", objectGrantSignature(config, grant));
    return { url: url.toString(), expiresAt: new Date(Number(expires) * 1000).toISOString() };
  };
  const createPreviewUrl = (key) => signedReadUrl(key, "preview", [EVIDENCE_PREFIX]);
  const createExportDownloadUrl = async (key) => (await signedReadUrl(key, "download", [EVIDENCE_PREFIX, EXPORT_PREFIX]));

  const removeFileAndMeta = async (key, prefixes) => {
    const filePath = objectPath(key, prefixes);
    await rm(filePath, { force: true });
    await rm(metaPath(key), { force: true });
    logger.debug?.({ key }, "local storage object removed");
  };
  // 幂等安全删除：对象不存在视同成功（与 COS deleteObject 吞 NoSuchKey 同口径）。
  const deleteObject = (key) => removeFileAndMeta(key, [EVIDENCE_PREFIX]);
  const deleteExportObject = (key) => removeFileAndMeta(key, [EXPORT_PREFIX]);

  const readObject = async (key) => {
    assertConfigured();
    const filePath = objectPath(key, [EVIDENCE_PREFIX]);
    try {
      return await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw missingObject();
      throw error;
    }
  };

  const verifyStoredObject = async ({ key, expectedSizeBytes, expectedSha256 }) => {
    assertConfigured();
    const filePath = objectPath(key, [EVIDENCE_PREFIX]);
    let body;
    try {
      body = await readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw storageError("OBJECT_MISSING", "存储对象缺失");
      throw error;
    }
    const sizeBytes = body.length;
    if (sizeBytes !== Number(expectedSizeBytes)) throw storageError("OBJECT_SIZE_MISMATCH", "对象大小不匹配");
    const sha256 = createHash("sha256").update(body).digest("hex");
    if (sha256 !== expectedSha256) throw storageError("OBJECT_SHA256_MISMATCH", "对象校验和不匹配");
    return { sizeBytes, sha256, storageVersionId: null };
  };

  // 归档恢复：本地对象永远处于热态——存在即 ready（无需恢复、不伪造过期时间），缺失即如实报错。
  const assertEvidenceObjectExists = async ({ key }) => {
    const filePath = objectPath(key, [EVIDENCE_PREFIX]);
    try {
      await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw storageError("ARCHIVE_OBJECT_MISSING", "存储对象不存在，无法恢复", 404);
      throw error;
    }
    return filePath;
  };
  const requestArchiveRestore = async ({ key }) => { await assertEvidenceObjectExists({ key }); };
  const archiveRestoreStatus = async ({ key }) => {
    await assertEvidenceObjectExists({ key });
    return { status: "ready", expiresAt: null };
  };

  // 导出文件：worker 直接写入（真实可下载文件），元数据旁车记录 contentType 供下载响应使用。
  const putExportObject = async ({ key, body, contentType = "text/csv; charset=utf-8" }) => {
    assertConfigured();
    const filePath = objectPath(key, [EXPORT_PREFIX]);
    await mkdir(path.dirname(filePath), { recursive: true });
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
    await writeFile(filePath, buffer);
    await mkdir(path.dirname(metaPath(key)), { recursive: true });
    await writeFile(metaPath(key), JSON.stringify({ contentType: String(contentType), sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"), writtenAt: clock().toISOString() }));
  };

  // 本地形态没有备份目标：显式失败关闭，绝不伪造备份成功/校验结果。
  const backupUnavailable = () => storageError("BACKUP_LOCAL_NOT_AVAILABLE", "本地存储形态不提供数据库备份上传；请切换 STORAGE_PROVIDER=cos 并配置 COS_BACKUP_BUCKET", 503, false);

  return Object.freeze({
    configured, exportConfigured: true, backupConfigured: false,
    assertConfigured, assertReady, createPostTarget, verifyObject, createPreviewUrl, deleteObject, readObject, verifyStoredObject,
    requestArchiveRestore, archiveRestoreStatus, putExportObject, deleteExportObject, createExportDownloadUrl,
    putBackupObject: async () => { throw backupUnavailable(); },
    headBackupObject: async () => { throw backupUnavailable(); },
    newObjectSuffix: () => randomBytes(16).toString("hex"),
    // 本地形态专有：供签名路由读取磁盘布局与元数据（仅 STORAGE_PROVIDER=local 时注册路由）。
    localStorageRoot: root,
  });
}
