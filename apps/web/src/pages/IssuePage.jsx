// IssuePage — issue 不得分/改分编辑（问卷子页，inventory §1.8；rules R41-R50 编辑会话与证据 / R99 录音播放单例）。
// 语义真源：apps/miniapp/miniprogram/pages/issue/index.js（84 行）逐函数移植。
// PM 钉定 Web 适配点：
// 1) onLoad ≈ 组件挂载解析 hash 路由六参数；onUnload ≈ useEffect cleanup（卸载清理 audio/recorder）。
// 2) 录音：MediaRecorder——时长上限 evidence.audioMaxDurationSeconds||10 秒（setTimeout 停止实现，
//    同一 recorder 实例复用、onstop 只绑一次）；<1s 拒收「录音至少需要 1 秒」；每题最多 3 段；
//    mime 经 isTypeSupported 按序选择（audio/mp4→audio/aac→audio/webm），并把真实 recorder.mimeType
//    原样透传（后端白名单接受 mp4/aac/mpeg/webm 等，按 base mime 归一化，容忍 ";codecs=" 后缀），
//    durationSeconds=向上取整秒；播放用单个 Audio 元素（objectURL 或服务端 previewUrl），
//    播完即 pause+置空（用完即停），组件卸载清理。
// 3) 选图：隐藏 <input type="file" accept="image/jpeg,image/png">（multiple 按余量）；
//    类型判定用 file.type/name 后缀（png→image/png 否则 image/jpeg）。
// 4) wx.showModal 类确认（本页无）；wx.navigateBack → context.back（仅当上一条应用内
//    路由确为同任务问卷才回退，否则 replace 携全量参数的规范问卷页）。
// 6) kind=session 的 BusinessError → redirectToLogin()。
import React, { useEffect, useRef, useState } from "react";
import { Button, Card, Muted, PageNav, SectionHeading, TextArea } from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { getQuestionnaire } from "../services/assignments.js";
import {
  cancelIssue, completeEvidenceUpload, confirmIssue, createEditSession,
  initEvidenceUpload, removeEvidence, updateEditSession,
} from "../services/drafts.js";
import { uploadToSignedTarget } from "../services/uploads.js";
import { getSession } from "../store/session.js";
import { recallSurveyCategory } from "../store/survey-view.js";
import { navEntryIsPage, sanitizeTaskSource } from "../router/nav-history.js";
import { endpointRegistry } from "../../../../packages/contracts/endpoint-registry.js";
import { secureUuid } from "../utils/business.js";

// 录音容器候选（按序取第一个 isTypeSupported 为真者）：iOS Safari → audio/mp4，Chrome/Android → audio/webm；
// 后端白名单按 base mime 归一化接受 mp4/aac/mpeg/webm（容忍 ";codecs=" 后缀）。
export const RECORDER_MIME_CANDIDATES = ["audio/mp4", "audio/aac", "audio/webm"];

// 路由离开/页面卸载时的尽力取消（fire-and-forget）。与 services/drafts.js 的 cancelIssue 逻辑有意重复：
// services 层经 adapters/http 不支持 keepalive，页面卸载后请求会被浏览器丢弃，故此处必须内联 fetch。
function sendEditSessionCancel(attemptId, questionId, editSessionId) {
  const session = getSession();
  fetch(endpointRegistry.drafts.cancelEdit.path(attemptId, questionId, editSessionId), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    },
    // 与 adapters/http 同规则：bearer-only，不带浏览器 cookie（同宿主 Admin cookie 串扰防护）。
    credentials: "omit",
    keepalive: true,
  }).catch(() => {}); // 尽力而为：失败不阻塞、不弹错
}

export function selectRecorderMime(isTypeSupported) {
  if (typeof isTypeSupported !== "function") return "";
  for (const mime of RECORDER_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // 探测异常视为不支持，继续下一候选。
    }
  }
  return "";
}

// 附件真实类型（等价 miniapp evidenceMime，js:86-90）。
function evidenceMime(file) {
  if (file.type === "audio") return file.mimeType || "audio/webm"; // PM 适配点 2：真实 recorder.mimeType 透传（isTypeSupported 按序选择，后端白名单接受 mp4/aac/webm 等）
  // PM 适配点 3：png → image/png，否则 image/jpeg（file.type/name 后缀判定）
  return file.mime === "image/png" || String(file.name || "").toLowerCase().endsWith(".png")
    ? "image/png"
    : "image/jpeg";
}

// hash 路由查询参数（Web 适配：页面自读，等价 miniapp onLoad(options)）。
function routeQuery() {
  const raw = String((typeof window !== "undefined" ? window.location.hash : "") || "").replace(/^#/, "");
  return new URLSearchParams(raw.split("?")[1] || "");
}

export function IssuePage() {
  const { back, replace, toast, redirectToLogin } = useApp();
  const [question, setQuestion] = useState(null);
  const [editSessionId, setEditSessionId] = useState("");
  const [target, setTarget] = useState("unscored");
  const [remark, setRemark] = useState("");
  const [images, setImages] = useState([]);
  const [audios, setAudios] = useState([]);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // 异步闭包内读取最新值（等价 miniapp this.data）；卸载后异步回调不再写状态。
  const latestRef = useRef({});
  const routeMetaRef = useRef(null);
  const questionRef = useRef(null);
  const editSessionIdRef = useRef("");
  const targetRef = useRef("unscored");
  const remarkRef = useRef("");
  const savingRef = useRef(false);
  const unloadedRef = useRef(false);
  // 任务链来源与路由指定分类（问卷写入）：兜底返回问卷时保持来源链与选中分类。
  const sourceRef = useRef("");
  const categoryParamRef = useRef("");
  // 会话清理（T4）：sessionClosedRef=会话已确认/已取消（卸载无需再取消）；pagehideRef=文档正在卸载
  // （刷新/关页，setTimeout 不可靠须同步直发）；leaveCancelTimerRef=SPA 路由离开的延迟取消定时器。
  const sessionClosedRef = useRef(false);
  const pagehideRef = useRef(false);
  const leaveCancelTimerRef = useRef(null);
  const evidenceSeqRef = useRef(0);
  // 选图（PM 适配点 3）：隐藏 file input。
  const fileInputRef = useRef(null);
  // 录音（PM 适配点 2 / R99）：同一 recorder 实例只绑一次 onStop/onerror/ondataavailable；
  // 停止时释放音轨（节能），下次录音重新取流并按需新建 recorder（recorderBoundRef 记录已绑定实例）。
  const recorderRef = useRef(null);
  const recorderBoundRef = useRef(null); // 已绑定事件回调的 recorder 实例（布尔→实例，换实例才重绑）
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const recordStartedAtRef = useRef(0);
  const recordingRef = useRef(false);
  // 播放（R99）：单例 Audio，卸载销毁。
  const audioRef = useRef(null);
  const objectUrlsRef = useRef([]);

  latestRef.current = { question, images, audios, remark, target };

  // 返回问卷：上一条应用内路由确为同任务问卷才 history.back（问卄件仍持有全部上下文）；
  // 否则（外部历史/直达进入）replace 到携全量业务参数、任务来源与分类（路由参数优先于
  // 会话记忆）的规范问卷 URL，绝不后退到外部页面或缺失参数的 /survey。
  const goBack = () => {
    const meta = routeMetaRef.current;
    if (!meta) {
      replace("/home");
      return;
    }
    const category = categoryParamRef.current || recallSurveyCategory(meta.attemptId);
    const fallback = `/survey?assignmentId=${encodeURIComponent(meta.assignmentId)}&attemptId=${encodeURIComponent(meta.attemptId)}&questionnaireVersionId=${encodeURIComponent(meta.questionnaireVersionId)}&revision=${meta.revision}&source=${sourceRef.current}${category ? `&category=${encodeURIComponent(category)}` : ""}`;
    back(fallback, (previous) => navEntryIsPage(previous, "/survey", {
      assignmentId: meta.assignmentId,
      attemptId: meta.attemptId,
    }));
  };

  const appendItem = (type, item) => {
    if (type === "image") setImages((prev) => [...prev, item]);
    else setAudios((prev) => [...prev, item]);
  };
  const replaceItem = (type, id, item) => {
    const updater = (prev) => prev.map((entry) => (entry.id === id ? item : entry));
    if (type === "image") setImages(updater);
    else setAudios(updater);
  };
  const removeLocalItem = (type, id) => {
    const updater = (prev) => prev.filter((entry) => entry.id !== id);
    if (type === "image") setImages(updater);
    else setAudios(updater);
  };

  // 证据上传三步链（R46）：init → 直传 → complete，须 staged_ready；失败项置 failed 可重试（R47）。
  const stageFile = async (fileMeta) => {
    // R45：单文件 >10MB 拒收，不入队列。
    if (fileMeta.size > 10 * 1024 * 1024) {
      toast("单个文件不能超过 10MB");
      return;
    }
    const questionId = questionRef.current?.id;
    const sessionScope = editSessionIdRef.current;
    if (!questionId || !sessionScope || !routeMetaRef.current) return;
    const tempId = `local-${evidenceSeqRef.current}`;
    evidenceSeqRef.current += 1;
    const clientFileId = secureUuid(); // R46/R47：每次走链（含重试）都生成新 clientFileId
    appendItem(fileMeta.type, {
      id: tempId,
      type: fileMeta.type,
      path: fileMeta.path,
      size: fileMeta.size,
      durationSeconds: fileMeta.durationSeconds,
      file: fileMeta.file,
      status: "uploading",
      progressLabel: "正在上传",
    });
    try {
      const init = await initEvidenceUpload(routeMetaRef.current.attemptId, questionId, sessionScope, {
        clientFileId,
        type: fileMeta.type,
        mimeType: evidenceMime(fileMeta),
        sizeBytes: fileMeta.size,
        durationSeconds: fileMeta.durationSeconds,
      });
      if (unloadedRef.current) return;
      await uploadToSignedTarget(init.uploadTarget, fileMeta.file);
      if (unloadedRef.current) return;
      const completed = await completeEvidenceUpload(routeMetaRef.current.attemptId, questionId, sessionScope, init.attachmentId, {
        uploadToken: init.uploadToken,
        sizeBytes: fileMeta.size,
        durationSeconds: fileMeta.durationSeconds,
      });
      if (unloadedRef.current) return;
      if (completed.status !== "staged_ready") throw new Error("附件尚未确认，请重试");
      // complete 响应携带最新 attempt revision（上传会 +1）：就地前移，保证随后 PATCH/confirm 用新值。
      // 并发多附件完成乱序返回时 revision 只前进不回退（attempt revision 单调递增），
      // 真正的服务端冲突仍由 save() 的 409 检测兜底。
      const returnedRevision = Number(completed.revision);
      if (routeMetaRef.current && Number.isSafeInteger(returnedRevision)
        && returnedRevision > Number(routeMetaRef.current.revision || 0)) {
        routeMetaRef.current.revision = returnedRevision;
      }
      replaceItem(fileMeta.type, tempId, {
        ...completed,
        id: init.attachmentId,
        type: fileMeta.type,
        path: fileMeta.path,
        size: fileMeta.size,
        durationSeconds: fileMeta.durationSeconds,
        file: fileMeta.file,
        status: "staged_ready",
        progressLabel: "上传成功",
      });
    } catch (uploadError) {
      if (unloadedRef.current) return;
      if (uploadError?.kind === "session") {
        removeLocalItem(fileMeta.type, tempId);
        toast(uploadError.message);
        redirectToLogin();
        return;
      }
      replaceItem(fileMeta.type, tempId, {
        id: tempId,
        type: fileMeta.type,
        path: fileMeta.path,
        size: fileMeta.size,
        durationSeconds: fileMeta.durationSeconds,
        file: fileMeta.file,
        status: "failed",
        progressLabel: uploadError?.message || "上传失败，请重试",
      });
    }
  };

  // 选图（R43 / PM 适配点 3）：余量 ≤0 toast；选择数量取余量。
  // 问题照片已全面选填，但所有题都可传；上限默认 4 张（服务端未配置时同值）。
  const chooseImage = () => {
    const maxCount = latestRef.current.question?.evidence?.imageMaxCount || 4;
    const remaining = maxCount - latestRef.current.images.length;
    if (remaining <= 0) {
      toast(`每题最多上传 ${maxCount} 张照片`);
      return;
    }
    fileInputRef.current?.click();
  };

  const onFilesChosen = (event) => {
    const input = event.target;
    const chosen = Array.from(input.files || []);
    input.value = ""; // 允许重复选择同一文件
    const maxCount = latestRef.current.question?.evidence?.imageMaxCount || 4;
    const remaining = maxCount - latestRef.current.images.length;
    chosen.slice(0, Math.max(0, remaining)).forEach((file) => {
      stageFile({ type: "image", file, path: "", size: file.size, name: file.name, mime: file.type });
    });
  };

  // R99：同一 recorder 实例只绑一次 onStop/onerror/ondataavailable（避免重复监听导致同一段录音多次上传）。
  // 复用条件：recorder 存在且其音轨流仍在；停止时音轨已释放 → 下次录音重新 getUserMedia 取新流（评审缺陷 2 修复）。
  const getRecorder = async () => {
    const liveStream = streamRef.current?.getAudioTracks?.().some((track) => track.readyState !== "ended");
    if (recorderRef.current && liveStream) return recorderRef.current;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== "function") {
      throw new Error("当前浏览器不支持录音");
    }
    // 残留旧 recorder/流已随音轨释放失效，先丢弃再取新流
    recorderRef.current = null;
    streamRef.current = null;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    // 容器按 isTypeSupported 按序选择（iOS → audio/mp4，Chrome/Android → audio/webm），不依赖浏览器默认。
    const preferred = selectRecorderMime(typeof window !== "undefined" && window.MediaRecorder?.isTypeSupported?.bind(window.MediaRecorder));
    let recorder;
    try {
      recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    } catch {
      // 极端环境带 mimeType 构造抛 NotSupportedError：退回无参构造保可用，下游仍上报真实 recorder.mimeType。
      recorder = new MediaRecorder(stream);
    }
    recorderRef.current = recorder;
    if (recorderBoundRef.current !== recorder) {
      recorderBoundRef.current = recorder;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        if (recordTimerRef.current) {
          clearTimeout(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        recordingRef.current = false;
        if (!unloadedRef.current) setRecording(false);
        const streamToRelease = streamRef.current;
        streamRef.current = null;
        if (streamToRelease) streamToRelease.getTracks().forEach((track) => track.stop());
        if (unloadedRef.current) {
          chunksRef.current = [];
          return;
        }
        const durationMs = Date.now() - recordStartedAtRef.current;
        const mimeType = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        // R44：录音结束时长 <1s 拒收。
        if (durationMs < 1000 || !blob.size) {
          toast("录音至少需要 1 秒");
          return;
        }
        const durationSeconds = Math.ceil(durationMs / 1000);
        const extension = (mimeType.split(";")[0].split("/")[1] || "webm").replace(/[^a-z0-9]/gi, "") || "webm";
        const name = `evidence.${extension}`;
        const file = new File([blob], name, { type: mimeType });
        const path = URL.createObjectURL(blob);
        objectUrlsRef.current.push(path);
        stageFile({ type: "audio", file, path, size: blob.size, name, mimeType, durationSeconds });
      });
      // 录音出错：复位状态并释放音轨，不暂存任何音频（若无有效数据，后续 stop 事件走 <1s 拒收）。
      recorder.addEventListener("error", () => {
        if (recordTimerRef.current) {
          clearTimeout(recordTimerRef.current);
          recordTimerRef.current = null;
        }
        recordingRef.current = false;
        if (!unloadedRef.current) setRecording(false);
        chunksRef.current = [];
        const streamToRelease = streamRef.current;
        streamRef.current = null;
        if (streamToRelease) streamToRelease.getTracks().forEach((track) => track.stop());
      });
    }
    return recorder;
  };

  const stopRecording = () => {
    if (recordTimerRef.current) {
      clearTimeout(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  // 录音（R44）：每题最多 3 段；时长上限 audioMaxDurationSeconds||10 秒（setTimeout 停止，PM 适配点 2）。
  const toggleRecord = async () => {
    if (recordingRef.current) {
      stopRecording();
      return;
    }
    if (latestRef.current.audios.length >= 3) {
      toast("每题最多上传 3 段音频");
      return;
    }
    let recorder;
    try {
      recorder = await getRecorder();
    } catch {
      toast("未能启动录音，请检查麦克风权限后重试");
      return;
    }
    chunksRef.current = [];
    recordStartedAtRef.current = Date.now();
    recorder.start(); // MediaRecorder 无 duration 参数，到点由 setTimeout 停止
    recordingRef.current = true;
    setRecording(true);
    const maxSeconds = latestRef.current.question?.evidence?.audioMaxDurationSeconds || 10;
    recordTimerRef.current = setTimeout(() => stopRecording(), maxSeconds * 1000);
  };

  // R47：失败项重试 = 先本地移除，再以原内容重走完整链路（新 clientFileId 在 stageFile 内生成）。
  const retryUpload = (id) => {
    const item = [...latestRef.current.images, ...latestRef.current.audios].find((entry) => entry.id === id);
    if (!item || !item.file) return;
    removeLocalItem(item.type, id);
    stageFile({ type: item.type, file: item.file, path: item.path, size: item.size || 0, durationSeconds: item.durationSeconds });
  };

  // R48：删除分流——id 以 local- 开头（未完成 init 的本地项）仅本地移除；否则先删远端，成功才本地移除。
  const deleteEvidence = async (id, type) => {
    const item = [...latestRef.current.images, ...latestRef.current.audios].find((entry) => entry.id === id);
    if (!item) return;
    if (!String(id).startsWith("local-")) {
      try {
        await removeEvidence(routeMetaRef.current.attemptId, questionRef.current.id, editSessionIdRef.current, id);
      } catch (deleteError) {
        if (deleteError?.kind === "session") {
          toast(deleteError.message);
          redirectToLogin();
          return;
        }
        toast(deleteError?.message || "删除失败，请重试"); // 失败本地不移除
        return;
      }
    }
    removeLocalItem(type, id);
  };

  // R99：播放用单例 Audio；无 path 且无 previewUrl 的项点击无效。
  const getAudio = () => {
    if (audioRef.current) return audioRef.current;
    const audio = new Audio();
    audio.addEventListener("ended", () => {
      // PM 适配点 2：播完即 pause + 置空（用完即停）。
      audio.pause();
      audio.removeAttribute("src");
    });
    audioRef.current = audio;
    return audio;
  };

  const play = (item) => {
    const src = item.path || item.previewUrl;
    if (!src) return;
    const audio = getAudio();
    audio.pause();
    audio.src = src;
    audio.play().catch(() => toast("音频播放失败，请重试"));
  };

  // R50：确认——先 updateEditSession 写说明，再 confirmIssue 提交 {answer: target, revision}，成功返回问卷。
  const save = async () => {
    if (savingRef.current) return;
    const currentTarget = targetRef.current;
    if (currentTarget === "unscored") {
      // R49 必填校验（按固定顺序；target=scored 全部跳过）。
      // 问题照片已全面选填：历史 imageRequired 配置不再强制（无照片+说明可确认）；
      // 音频要求保持既有口径；在途附件仍需等待完成。
      if (!remarkRef.current.trim()) {
        toast("请填写问题说明");
        return;
      }
      if (questionRef.current?.evidence?.audioRequired
        && !latestRef.current.audios.some((item) => ["active", "staged_ready"].includes(item.status))) {
        toast("请先上传成功的问题音频");
        return;
      }
      if ([...latestRef.current.images, ...latestRef.current.audios].some((item) => item.status === "uploading")) {
        toast("请等待附件上传完成");
        return;
      }
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await updateEditSession(routeMetaRef.current.attemptId, questionRef.current.id, editSessionIdRef.current, {
        draftIssueRemark: currentTarget === "unscored" ? remarkRef.current.trim() : "",
        revision: routeMetaRef.current.revision,
      });
      await confirmIssue(routeMetaRef.current.attemptId, questionRef.current.id, editSessionIdRef.current, {
        answer: currentTarget,
        revision: routeMetaRef.current.revision,
      });
      sessionClosedRef.current = true; // 会话已确认关闭，卸载时无需再尽力取消
      if (unloadedRef.current) return;
      goBack();
    } catch (saveError) {
      if (saveError?.kind === "session") {
        toast(saveError.message);
        redirectToLogin();
      } else {
        toast(saveError?.message || "保存失败，请重试");
      }
    } finally {
      savingRef.current = false;
      if (!unloadedRef.current) setSaving(false);
    }
  };

  // R50/R42：取消——无会话 id 直接返回；有则调 cancel 端点后返回，失败 toast 不返回。
  const cancel = async () => {
    if (!editSessionIdRef.current) {
      goBack();
      return;
    }
    try {
      await cancelIssue(routeMetaRef.current.attemptId, questionRef.current.id, editSessionIdRef.current);
      sessionClosedRef.current = true; // 会话已取消关闭，卸载时无需再尽力取消
      if (unloadedRef.current) return;
      goBack();
    } catch (cancelError) {
      if (cancelError?.kind === "session") {
        toast(cancelError.message);
        redirectToLogin();
      } else {
        toast(cancelError?.message || "取消失败，请重试");
      }
    }
  };

  // onLoad 等价：六参数校验（revision 缺省 0、target 默认 unscored），加载问卷定位题目并建编辑会话（R41）。
  useEffect(() => {
    // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
    unloadedRef.current = false;
    // 重挂载清除上一次卸载遗留的延迟取消定时器（StrictMode 假卸载不得误杀恢复的会话）。
    if (leaveCancelTimerRef.current) {
      clearTimeout(leaveCancelTimerRef.current);
      leaveCancelTimerRef.current = null;
    }
    // pagehide = 文档真正卸载中（刷新/关页），cleanup 据此选择同步直发而非延迟取消。
    const onPageHide = () => { pagehideRef.current = true; };
    window.addEventListener("pagehide", onPageHide);
    const params = routeQuery();
    const assignmentId = params.get("assignmentId") || "";
    const attemptId = params.get("attemptId") || "";
    const questionnaireVersionId = params.get("questionnaireVersionId") || "";
    const questionId = params.get("questionId") || "";
    if (!assignmentId || !attemptId || !questionnaireVersionId || !questionId) {
      setLoading(false);
      setError("未找到题目，请返回问卷重试");
      return () => { unloadedRef.current = true; };
    }
    const meta = {
      assignmentId,
      attemptId,
      questionnaireVersionId,
      revision: Number(params.get("revision") || 0),
    };
    routeMetaRef.current = meta;
    sourceRef.current = sanitizeTaskSource(params.get("source") || "");
    categoryParamRef.current = params.get("category") || "";
    const nextTarget = params.get("target") || "unscored";
    targetRef.current = nextTarget;
    setTarget(nextTarget);

    const load = async () => {
      try {
        const draft = await getQuestionnaire(meta.assignmentId);
        if (unloadedRef.current) return;
        // 以服务端最新 attempt revision 为准（URL 携带的可能已过期）：问卷每次作答/上传都会
        // 递增 revision，随后 update/confirm 都以该值提交，避免旧值 409。
        const draftRevision = Number(draft?.attempt?.revision);
        if (Number.isSafeInteger(draftRevision)) routeMetaRef.current.revision = draftRevision;
        const nextQuestion = draft.questions.find((item) => item.id === questionId);
        if (!nextQuestion) throw new Error("题目已更新，请刷新问卷后重试");
        const current = draft.answers?.[nextQuestion.id];
        const session = await createEditSession(meta.attemptId, nextQuestion.id, {
          baseAnswerRevision: current?.revision || 0,
          targetAnswer: targetRef.current,
        });
        if (unloadedRef.current) return;
        const attachments = session.activeAttachments || current?.attachments || [];
        questionRef.current = nextQuestion;
        editSessionIdRef.current = session.id;
        const initialRemark = session.draftIssueRemark ?? current?.remark ?? "";
        remarkRef.current = initialRemark;
        setQuestion(nextQuestion);
        setEditSessionId(session.id);
        setRemark(initialRemark);
        setImages(attachments.filter((item) => item.type === "image"));
        setAudios(attachments.filter((item) => item.type === "audio"));
        setLoading(false);
      } catch (loadError) {
        if (unloadedRef.current) return;
        if (loadError?.kind === "session") {
          toast(loadError.message);
          redirectToLogin();
          return;
        }
        setLoading(false);
        setError(loadError?.message || "暂时无法打开编辑，请重试");
      }
    };
    load();
    return () => {
      // onUnload 等价（R99 / PM 适配点 2）：清理录音、音频与 objectURL。
      window.removeEventListener("pagehide", onPageHide);
      unloadedRef.current = true;
      if (recordTimerRef.current) {
        clearTimeout(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        try { recorder.stop(); } catch { /* 已停止 */ }
      }
      const stream = streamRef.current;
      if (stream) stream.getTracks().forEach((track) => track.stop());
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audioRef.current = null;
      }
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current = [];
      // 路由离开/卸载尽力取消编辑会话（后端恢复语义兜底；会话已确认/取消则无需再取消）。
      const attemptId = routeMetaRef.current?.attemptId;
      const questionId = questionRef.current?.id;
      const editSessionId = editSessionIdRef.current;
      if (attemptId && questionId && editSessionId && !sessionClosedRef.current) {
        if (pagehideRef.current) {
          // 刷新/关页：setTimeout 不可靠，同步直发 keepalive 请求。
          sendEditSessionCancel(attemptId, questionId, editSessionId);
        } else {
          // SPA 路由离开：延迟后再复查 unloadedRef 仍为 true 才发——StrictMode 重挂载会把它
          // 置回 false，从而跳过取消，避免误杀重挂载恢复的会话。
          leaveCancelTimerRef.current = setTimeout(() => {
            leaveCancelTimerRef.current = null;
            if (unloadedRef.current) sendEditSessionCancel(attemptId, questionId, editSessionId);
          }, 200);
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const viewState = loading ? "loading" : error ? "error" : "ready";
  const evidence = question?.evidence || {};
  const imageMaxCount = evidence.imageMaxCount || 4;
  const audioMaxSeconds = evidence.audioMaxDurationSeconds || 10;
  const imageRemaining = imageMaxCount - images.length;
  const evidenceLabel = (item, savedText) => item.progressLabel || (item.status === "active" ? savedText : "上传成功");
  // R49 就地守卫：unscored 且说明为空 → 禁用确认（target=scored 场景不受影响；save 内 toast 校验保留作兜底）。
  const remarkMissing = target === "unscored" && !remark.trim();

  return (
    <div className="app-page app-page--flat" data-page="issue" data-state={viewState} data-target={target}>
      <PageNav title="不得分" onBack={cancel} />

      {loading ? (
        <Card><Muted>正在打开临时编辑…</Muted></Card>
      ) : error ? (
        <Card><div className="inline-error">{error}</div></Card>
      ) : question ? (
        <>
          {/* 题目卡（§1.8 a.3） */}
          <Card>
            <span className="eyebrow">第 {question.number} 题</span>
            <div style={{ marginTop: 6, fontSize: 14, lineHeight: 1.6 }}>{question.text}</div>
          </Card>

          {target === "scored" ? (
            /* target=scored：改为确认卡（R38，等价 miniapp 仅提示文案）；
               确认（底部）走 save 链（跳过全部必填校验），取消（底部）走 cancel 链 */
            <Card>
              <SectionHeading>改为得分？</SectionHeading>
              <div style={{ marginTop: 6 }}><Muted>确认后将清除当前问题说明和证据；取消不会改变原答案。</Muted></div>
            </Card>
          ) : (
            <>
              {/* 问题说明（必填） */}
              <Card>
                <label className="field">
                  <span className="field__label">问题说明 <span className="required">*</span></span>
                  <TextArea
                    value={remark}
                    placeholder="请描述现场看到的问题，可使用系统输入法语音输入"
                    onChange={(event) => {
                      remarkRef.current = event.target.value;
                      setRemark(event.target.value);
                    }}
                  />
                </label>
                {remarkMissing ? <div className="inline-error" style={{ marginTop: 6 }}>请填写问题说明后再确认</div> : null}
              </Card>

              {/* 问题照片：所有题目可见、选填（历史 imageRequired 配置不再强制；默认上限 4 张） */}
              <Card data-evidence-photos="optional">
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <span className="field__label">问题照片（选填）</span>
                  <Muted>每题最多 {imageMaxCount} 张，单张不超过 10MB</Muted>
                </div>
                <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                  {images.map((item) => (
                    <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                      <span style={{ flex: 1 }}>{evidenceLabel(item, "已保存照片")}</span>
                      {item.status === "failed" ? <Button variant="link" small onClick={() => retryUpload(item.id)}>重试</Button> : null}
                      <Button variant="link" small onClick={() => deleteEvidence(item.id, "image")}>删除</Button>
                    </div>
                  ))}
                  {imageRemaining > 0 ? (
                    <Button variant="outline" small onClick={chooseImage}>拍照或相册（最多 {imageMaxCount} 张）</Button>
                  ) : null}
                </div>
                {/* PM 适配点 3：隐藏 file input，multiple 按余量 */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  multiple={imageRemaining > 1}
                  style={{ display: "none" }}
                  onChange={onFilesChosen}
                />
              </Card>

              {/* 问题音频（audioRequired 时，§1.8 a.5） */}
              {evidence.audioRequired ? (
                <Card>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <span className="field__label">问题音频 <span className="required">*</span></span>
                    <Muted>每题最多 3 段，每段至少 1 秒</Muted>
                  </div>
                  <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                    {audios.map((item) => (
                      <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <span style={{ flex: 1 }}>{evidenceLabel(item, "已保存音频")}</span>
                        {item.status === "failed" ? <Button variant="link" small onClick={() => retryUpload(item.id)}>重试</Button> : null}
                        <Button variant="link" small onClick={() => play(item)}>播放</Button>
                        <Button variant="link" small onClick={() => deleteEvidence(item.id, "audio")}>删除</Button>
                      </div>
                    ))}
                    <Button variant="outline" small onClick={toggleRecord}>
                      {recording ? "停止录制" : `录制音频（最长 ${audioMaxSeconds} 秒）`}
                    </Button>
                  </div>
                </Card>
              ) : null}
            </>
          )}

          {/* 底部操作（scored 确认卡场景下同样可用，等价 miniapp sticky-actions 常驻） */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 8, marginTop: 8 }}>
            <Button variant="outline" onClick={cancel} disabled={saving}>取消</Button>
            <Button onClick={save} disabled={saving || remarkMissing}>确认</Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
