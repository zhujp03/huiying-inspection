// 本地磁盘对象的签名路由（仅 STORAGE_PROVIDER=local 时注册，COS 形态不存在这些端点）。
//
// POST /api/local-storage/objects  签名授权 multipart 直传（替代 COS POST 表单）；
// GET  /api/local-storage/objects  签名授权读取（operation=preview 内联预览 / download 附件下载）。
//
// 安全模型与预签名 URL 同级：不暴露磁盘目录树，访问必须携带短时 HMAC 授权——
// upload 绑定 key/nonce/精确字节数/声明类型/过期；preview/download 绑定 key/操作/过期。
// 媒体标签无法携带 bearer 头，签名短时 URL 即授权（与 COS 预签名一致）。
// 大文件解析上限只作用于本路由：multipart 上限由插件 limits.fileSize（10MiB）与授权精确
// 字节数在流式读取阶段强制；路由级 bodyLimit 兜底非 multipart 请求体。其余路由保持应用默认 1MiB。
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import multipart from "@fastify/multipart";
import { assertSafeKey, MAX_LOCAL_EVIDENCE_BYTES, verifyObjectGrant } from "./local.js";

const EXPORT_PREFIX = "exports/";
const EVIDENCE_PREFIX = "attempts/";
// 非 multipart 请求体兜底上限（multipart 开销余量 128KiB）；multipart 真实上限见插件 limits。
const UPLOAD_BODY_LIMIT = MAX_LOCAL_EVIDENCE_BYTES + 128 * 1024;

const writeObjectMeta = (metaPath, data) => writeFile(metaPath, JSON.stringify(data));

export function registerLocalStorageRoutes(app, { config, storage }) {
  const root = storage.localStorageRoot;
  const metaPath = (key) => path.join(root, "meta", `${key}.json`);

  app.register(async function localStorageScope(scope) {
    await scope.register(multipart, {
      // fileSize 比 10MiB 契约上限多 1 字节：busboy 超限即静默截断，把“多出的字节”留给
      // 授权字节数逐块复核以显式 413（不把截断后的对象冒充上传成功）。
      limits: { fileSize: MAX_LOCAL_EVIDENCE_BYTES + 1, files: 1, fields: 16, fieldSize: 16 * 1024, parts: 24 },
    });

    scope.post("/api/local-storage/objects", { bodyLimit: UPLOAD_BODY_LIMIT }, async (request, reply) => {
      if (!request.isMultipart()) throw Object.assign(new Error("必须使用 multipart/form-data 上传"), { code: "STORAGE_UPLOAD_INVALID", statusCode: 415 });
      const fields = {};
      let filePart = null;
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (part.fieldname !== "file" || !part.filename) throw Object.assign(new Error("缺少上传文件字段 file"), { code: "STORAGE_UPLOAD_INVALID", statusCode: 400 });
            filePart = part;
            break;
          }
          fields[part.fieldname] = part.value;
        }
      } catch (error) {
        // busboy 限额（单文件超 10MiB / 部件数超限）：统一映射为 413，不泄漏内部细节。
        const multipartErrors = scope.multipartErrors || {};
        const tooLarge = [multipartErrors.RequestFileTooLargeError, multipartErrors.PartsLimitError, multipartErrors.FilesLimitError].some((kind) => kind && error instanceof kind);
        if (tooLarge) throw Object.assign(new Error("上传文件过大"), { code: "STORAGE_UPLOAD_TOO_LARGE", statusCode: 413 });
        throw error;
      }
      // 客户端（H5/小程序）先写授权字段再追加文件；文件先到而授权不全即拒绝，不做流式猜测。
      const grant = verifyObjectGrant(config, { operation: "upload", key: fields.key, nonce: fields.nonce, size: fields.size, contentType: fields.contentType, expires: fields.expires, signature: fields.signature });
      if (!filePart) throw Object.assign(new Error("缺少上传文件字段 file"), { code: "STORAGE_UPLOAD_INVALID", statusCode: 400 });
      const filePath = assertSafeKey(root, grant.key, [EVIDENCE_PREFIX]);

      // 先落临时文件再原子 link 占位：磁盘上要么是完整对象，要么什么都没有（不冒充成功）。
      // 写一次性（write-once）：link() 原子创建、已存在即失败（EEXIST），杜绝重放覆盖已校验/已提交的
      // 原件——同字节重放按幂等成功处理（原件与元数据不动），异字节重放 409 拒绝且原件不变。
      await mkdir(path.join(root, "tmp"), { recursive: true });
      const tmpFile = path.join(root, "tmp", `upload-${randomBytes(12).toString("hex")}.part`);
      let tmpCreated = false;
      try {
        const handle = await open(tmpFile, "wx", 0o600);
        tmpCreated = true;
        const digest = createHash("sha256");
        let received = 0;
        try {
          for await (const chunk of filePart.file) {
            received += chunk.length;
            if (received > grant.size) throw Object.assign(new Error("上传内容大小与授权不一致"), { code: "STORAGE_UPLOAD_SIZE_MISMATCH", statusCode: 413 });
            digest.update(chunk);
            await handle.write(chunk);
          }
        } finally {
          await handle.close();
        }
        if (received !== grant.size) {
          filePart.file.destroy?.();
          throw Object.assign(new Error("上传内容大小与授权不一致"), { code: "STORAGE_UPLOAD_SIZE_MISMATCH", statusCode: 422 });
        }
        const sha256 = digest.digest("hex");
        await mkdir(path.dirname(filePath), { recursive: true });
        let replayEtag = null;
        try {
          await link(tmpFile, filePath);
        } catch (error) {
          if (error?.code !== "EEXIST") throw error;
          const existing = await readFile(filePath);
          const existingSha = createHash("sha256").update(existing).digest("hex");
          if (existing.length !== received || existingSha !== sha256) {
            throw Object.assign(new Error("对象已存在且内容不一致，禁止覆盖"), { code: "STORAGE_OBJECT_EXISTS", statusCode: 409 });
          }
          // 幂等重放：补齐缺失的元数据旁车（历史写元数据中断的恢复场景），其余保持原样。
          replayEtag = existingSha;
          let existingMeta = null;
          try { existingMeta = JSON.parse(await readFile(metaPath(grant.key), "utf8")); } catch { existingMeta = null; }
          if (!existingMeta) {
            await mkdir(path.dirname(metaPath(grant.key)), { recursive: true });
            await writeObjectMeta(metaPath(grant.key), { uploadNonce: grant.nonce, contentType: grant.contentType, sizeBytes: grant.size, sha256 });
          }
        }
        if (replayEtag) {
          reply.header("etag", `"${replayEtag}"`);
          return reply.code(204).send();
        }
        await mkdir(path.dirname(metaPath(grant.key)), { recursive: true });
        await writeObjectMeta(metaPath(grant.key), { uploadNonce: grant.nonce, contentType: grant.contentType, sizeBytes: grant.size, sha256 });
        reply.header("etag", `"${sha256}"`);
        return reply.code(204).send();
      } finally {
        // 临时文件无论如何都清理：成功（link 后去除重复硬链）、幂等、冲突、流中断都不留残片；
        // open 失败（极小概率重名）时未持有该文件，不做清理以免误删并发请求的同名临时件。
        if (tmpCreated) await rm(tmpFile, { force: true });
      }
    });

    scope.get("/api/local-storage/objects", async (request, reply) => {
      const query = request.query || {};
      const grant = verifyObjectGrant(config, { operation: query.operation, key: query.key, expires: query.expires, signature: query.signature });
      const prefixes = grant.operation === "download" ? [EVIDENCE_PREFIX, EXPORT_PREFIX] : [EVIDENCE_PREFIX];
      const filePath = assertSafeKey(root, grant.key, prefixes);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch (error) {
        if (error?.code === "ENOENT") throw Object.assign(new Error("存储对象不存在或已删除"), { code: "STORAGE_OBJECT_MISSING", statusCode: 404 });
        throw error;
      }
      let meta = null;
      try { meta = JSON.parse(await readFile(metaPath(grant.key), "utf8")); } catch { meta = null; }
      const remainingSeconds = Math.max(0, grant.expires - Math.floor(Date.now() / 1000));
      reply.header("content-type", String(meta?.contentType || "application/octet-stream"));
      reply.header("content-length", fileStat.size);
      reply.header("x-content-type-options", "nosniff");
      reply.header("cache-control", `private, max-age=${remainingSeconds}`);
      if (grant.operation === "download") {
        // key 模式已限定 [A-Za-z0-9/._-]，basename 无注入风险；导出 key 以 .csv/.xlsx 结尾，浏览器即得正确文件名。
        reply.header("content-disposition", `attachment; filename="${path.basename(grant.key)}"`);
      } else {
        reply.header("content-disposition", "inline");
      }
      return reply.send(createReadStream(filePath));
    });
  });
}
