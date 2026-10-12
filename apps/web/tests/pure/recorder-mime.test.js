// selectRecorderMime 纯函数契约（录音容器按浏览器 isTypeSupported 按序选择，修复 webm 被后端拒收）。
// 候选顺序：audio/mp4（iOS Safari）→ audio/aac → audio/webm（Chrome/Android MediaRecorder 默认）；
// 后端白名单按 base mime 归一化接受 mp4/aac/mpeg/webm（容忍 ";codecs=" 后缀）。
import { describe, expect, it } from "vitest";
import { RECORDER_MIME_CANDIDATES, selectRecorderMime } from "../../src/pages/IssuePage.jsx";

describe("selectRecorderMime（IssuePage.jsx 录音容器选择）", () => {
  it("候选顺序常量钉定为 mp4 → aac → webm", () => {
    expect(RECORDER_MIME_CANDIDATES).toEqual(["audio/mp4", "audio/aac", "audio/webm"]);
  });

  it("iOS 路径：isTypeSupported 只认 audio/mp4 → 返回 audio/mp4", () => {
    const probed = [];
    const mime = selectRecorderMime((candidate) => {
      probed.push(candidate);
      return candidate === "audio/mp4";
    });
    expect(mime).toBe("audio/mp4");
    expect(probed).toEqual(["audio/mp4"]);
  });

  it("Chrome 路径：只认 audio/webm（含 ';codecs=opus' 探测入参返回真）→ 返回 audio/webm", () => {
    // 真实 Chrome 的 isTypeSupported 对 "audio/webm" 与 "audio/webm;codecs=opus" 均返回真；
    // 选择结果固定为裸候选串（探测入参与 codecs 后缀解耦）。
    const probed = [];
    const chromeLike = (mime) => {
      probed.push(mime);
      return mime === "audio/webm" || mime === "audio/webm;codecs=opus";
    };
    expect(selectRecorderMime(chromeLike)).toBe("audio/webm");
    // 按序探测：前两个候选返回假继续，第三个命中（探测入参均为裸候选串）。
    expect(probed).toEqual(["audio/mp4", "audio/aac", "audio/webm"]);
  });

  it("全支持 → 返回 audio/mp4（顺序优先，不选后面的候选）", () => {
    const probed = [];
    const mime = selectRecorderMime((candidate) => {
      probed.push(candidate);
      return true;
    });
    expect(mime).toBe("audio/mp4");
    expect(probed).toEqual(["audio/mp4"]);
  });

  it("全不支持 / 入参非函数 → 返回空串（调用方退回无参构造）", () => {
    expect(selectRecorderMime(() => false)).toBe("");
    expect(selectRecorderMime(undefined)).toBe("");
    expect(selectRecorderMime(null)).toBe("");
    expect(selectRecorderMime(true)).toBe("");
    expect(selectRecorderMime("audio/mp4")).toBe("");
  });

  it("探测函数抛异常 → 视为不支持，跳过该项继续（首个抛错、第二个为真 → 返回第二个）", () => {
    const mime = selectRecorderMime((candidate) => {
      if (candidate === "audio/mp4") throw new Error("probe exploded");
      return candidate === "audio/aac";
    });
    expect(mime).toBe("audio/aac");
  });
});
