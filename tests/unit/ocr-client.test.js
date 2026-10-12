// OCR 客户端分发测试：none/paddle/tencent 三态、recognize(lines) 形状契约、
// tencent provider 的 TC3 签名请求形状与响应/错误映射（mock fetch，不发真实请求）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOcrClient } from "../../apps/worker/src/ocr-client.js";
import { tc3Sign } from "../../apps/api/src/auth/providers.js";

const tencentConfig = { OCR_PROVIDER: "tencent", OCR_SECRET_ID: "id", OCR_SECRET_KEY: "key", OCR_REQUEST_TIMEOUT_MS: 5000 };
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

describe("createOcrClient dispatch", () => {
  it("none (default): configured=false and recognize throws OCR_NOT_CONFIGURED", async () => {
    for (const config of [{}, { OCR_PROVIDER: "none" }, { OCR_PROVIDER: "none", OCR_SERVICE_URL: "http://ocr:8080" }]) {
      const ocr = createOcrClient(config);
      expect(ocr.configured).toBe(false);
      await expect(ocr.recognize(Buffer.from("x"))).rejects.toMatchObject({ code: "OCR_NOT_CONFIGURED" });
    }
  });

  it("paddle requires both the provider switch and OCR_SERVICE_URL", () => {
    expect(createOcrClient({ OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "http://ocr:8080" }).configured).toBe(true);
    expect(createOcrClient({ OCR_PROVIDER: "paddle" }).configured).toBe(false);
  });

  it("paddle keeps the legacy sidecar fetch contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ lines: [{ text: "宫保鸡丁", confidence: 0.98, boundingBox: [[0, 0], [1, 1]] }] }))
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(okJson({ unexpected: true }));
    vi.stubGlobal("fetch", fetchMock);
    const ocr = createOcrClient({ OCR_PROVIDER: "paddle", OCR_SERVICE_URL: "http://ocr:8080", OCR_REQUEST_TIMEOUT_MS: 5000 });
    const image = Buffer.from("jpeg-bytes");
    await expect(ocr.recognize(image)).resolves.toEqual([{ text: "宫保鸡丁", confidence: 0.98, boundingBox: [[0, 0], [1, 1]] }]);
    expect(fetchMock).toHaveBeenCalledWith("http://ocr:8080/v1/ocr", expect.objectContaining({ method: "POST", body: image }));
    await expect(ocr.recognize(image)).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
    await expect(ocr.recognize(image)).rejects.toMatchObject({ code: "OCR_RESPONSE_INVALID" });
  });
});

describe("createOcrClient tencent provider (mock fetch)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const detections = [
    { DetectedText: "水煮鱼 一份", Confidence: 92, ItemCoord: { X: 10, Y: 20, Width: 100, Height: 30 } },
    { DetectedText: "", Confidence: 50 }, // 空文本行应被丢弃
    { DetectedText: "合计 128 元", Confidence: 88 }, // 缺 ItemCoord → boundingBox=[]
  ];

  it("configured only when the key pair is complete", () => {
    expect(createOcrClient(tencentConfig).configured).toBe(true);
    expect(createOcrClient({ ...tencentConfig, OCR_SECRET_KEY: "" }).configured).toBe(false);
  });

  it("sends a TC3-signed GeneralBasicOCR request with ImageBase64 payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ Response: { TextDetections: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const ocr = createOcrClient(tencentConfig);
    const lines = await ocr.recognize(Buffer.from("jpeg-bytes"));
    expect(lines).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ocr.tencentcloudapi.com");
    expect(init.headers["x-tc-action"]).toBe("GeneralBasicOCR");
    expect(init.headers["x-tc-version"]).toBe("2018-11-19");
    expect(init.headers["x-tc-region"]).toBe("ap-shanghai");
    expect(JSON.parse(init.body)).toEqual({ ImageBase64: Buffer.from("jpeg-bytes").toString("base64") });
    // 签名可复算：用请求头中的时间戳重建 now，tc3Sign 输出必须与请求头完全一致（防签名漂移）。
    const now = new Date(Number(init.headers["x-tc-timestamp"]) * 1000);
    const expected = tc3Sign({
      method: "POST", host: "ocr.tencentcloudapi.com", service: "ocr", action: "GeneralBasicOCR",
      version: "2018-11-19", region: "ap-shanghai", secretId: "id", secretKey: "key", now,
      payload: { ImageBase64: Buffer.from("jpeg-bytes").toString("base64") },
    });
    expect(init.headers.authorization).toBe(expected.headers.authorization);
    expect(init.headers.authorization).toMatch(/^TC3-HMAC-SHA256 Credential=id\/\d{4}-\d{2}-\d{2}\/ocr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
  });

  it("honours OCR_REGION override", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ Response: { TextDetections: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await createOcrClient({ ...tencentConfig, OCR_REGION: "ap-guangzhou" }).recognize(Buffer.from("x"));
    expect(fetchMock.mock.calls[0][1].headers["x-tc-region"]).toBe("ap-guangzhou");
  });

  it("maps TextDetections to the shared lines shape and normalises confidence to 0-1", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ Response: { TextDetections: detections } })));
    const lines = await createOcrClient(tencentConfig).recognize(Buffer.from("x"));
    expect(lines).toEqual([
      { text: "水煮鱼 一份", confidence: 0.92, boundingBox: [10, 20, 100, 30] },
      { text: "合计 128 元", confidence: 0.88, boundingBox: [] },
    ]);
  });

  it.each([
    ["retryable API error stays OCR_UNAVAILABLE", okJson({ Response: { Error: { Code: "RequestLimitExceeded", Message: "限频" } } }), "OCR_UNAVAILABLE"],
    ["permanent API error becomes OCR_RESPONSE_INVALID", okJson({ Response: { Error: { Code: "AuthFailure.SignatureFailure", Message: "签名" } } }), "OCR_RESPONSE_INVALID"],
    ["oversized image fails terminally without retry", okJson({ Response: { Error: { Code: "InvalidParameterValue.ImageSizeExceed", Message: "超限" } } }), "OCR_RESPONSE_INVALID"],
    ["HTTP failure without API error stays OCR_UNAVAILABLE", { ok: false, status: 500, json: async () => ({}) }, "OCR_UNAVAILABLE"],
    ["malformed JSON stays OCR_UNAVAILABLE", { ok: true, status: 200, json: async () => { throw new Error("bad json"); } }, "OCR_UNAVAILABLE"],
    ["missing TextDetections is OCR_RESPONSE_INVALID", okJson({ Response: {} }), "OCR_RESPONSE_INVALID"],
  ])("%s", async (_name, response, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(createOcrClient(tencentConfig).recognize(Buffer.from("x"))).rejects.toMatchObject({ code });
  });

  it("maps network failures to OCR_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(createOcrClient(tencentConfig).recognize(Buffer.from("x"))).rejects.toMatchObject({ code: "OCR_UNAVAILABLE" });
  });

  it("not-configured tencent client throws OCR_NOT_CONFIGURED", async () => {
    const ocr = createOcrClient({ ...tencentConfig, OCR_SECRET_ID: "" });
    await expect(ocr.recognize(Buffer.from("x"))).rejects.toMatchObject({ code: "OCR_NOT_CONFIGURED" });
  });
});
