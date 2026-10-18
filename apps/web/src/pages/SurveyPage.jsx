// SurveyPage — survey 暗访问卷·第一步 答题（inventory §1.7；rules R31-R40）。
// 语义真源：apps/miniapp/miniprogram/pages/survey/index.js（101 行）逐函数移植。
// PM 钉定 Web 适配点：
// 1) onLoad ≈ 组件挂载解析 hash 路由四参数；onShow ≈ 从 issue 返回时组件重挂载（自动重新 load）；
//    onUnload ≈ useEffect cleanup（卸载后异步回调不再写状态）。
// 6) kind=session 的 BusinessError → redirectToLogin()（PM 适配点 6）。
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, FlowSteps, Muted, PageNav } from "../design/components.jsx";
import { useApp } from "./app-context.jsx";
import { getQuestionnaire } from "../services/assignments.js";
import { saveAnswer } from "../services/drafts.js";
import { advanceDraftRevision, markDraftSynced, peekDraft, saveDraft } from "../store/survey.js";
import { recallSurveyCategory, rememberSurveyCategory } from "../store/survey-view.js";
import { mergeSurveyAnswers } from "../store/survey-merge.js";
import { navEntryIsPage, sanitizeTaskSource } from "../router/nav-history.js";
import { firstIncompleteQuestion } from "../utils/business.js";

// 分类由服务端动态下发（管理员可扩展）；此处仅作接口异常时的兜底展示（R33）。
const FALLBACK_CATEGORIES = [
  { id: "environment", label: "环境卫生" },
  { id: "service", label: "为客服务" },
  { id: "product", label: "产品品质" },
];

// hash 路由查询参数（Web 适配：页面自读，等价 miniapp onLoad(options)）。
function routeQuery() {
  const raw = String((typeof window !== "undefined" ? window.location.hash : "") || "").replace(/^#/, "");
  return new URLSearchParams(raw.split("?")[1] || "");
}

// 补发顺序（R36）：pendingResync 按题号升序；找不到题号的排最后。
const pendingQuestionOrder = (pendingIds, questions) => {
  const numbers = new Map((questions || []).map((question) => [question.id, question.number]));
  return [...pendingIds].sort((a, b) => {
    const left = numbers.get(a);
    const right = numbers.get(b);
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  });
};

export function SurveyPage({ routeCategory = "" }) {
  const { back, navigate, replace, toast, redirectToLogin } = useApp();
  const [categories, setCategories] = useState(FALLBACK_CATEGORIES);
  const [category, setCategory] = useState(FALLBACK_CATEGORIES[0].id);
  const [meta, setMeta] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [expanded, setExpanded] = useState({});
  const [conflict, setConflict] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  // 异步闭包内读取最新值（等价 miniapp this.data）；卸载后不再写状态。
  const latestRef = useRef({});
  const routeMetaRef = useRef(null);
  const pendingCategoryRef = useRef("");
  // 返回任务所需的来源（?source=，由任务页写入；已提交回跳任务详情时原样带回）。
  const sourceRef = useRef("");
  const unloadedRef = useRef(false);
  // 草稿同步时序（T3）：尚未补发到服务端的 scored 题；补发成功前草稿不得整体置已同步。
  const pendingResyncRef = useRef(new Set());
  // load 进行中互斥：online 恢复/初始加载/手点重试并发时防同题双发。
  const loadInProgressRef = useRef(false);
  const loadRef = useRef(null);

  latestRef.current = { answers, questions, categories, category, meta };

  const putAnswers = (value) => {
    latestRef.current.answers = value;
    setAnswers(value);
  };

  // 用服务端分类列表替换兜底：路由指定的分类有效则优先，其次是本会话记忆的选中分类
  //（Issue 往返/浏览器后退/刷新重挂载时不丢当前分类），再次落在当前有效分类或第一个分类上（R33）。
  const applyCategories = (result) => {
    const nextCategories = Array.isArray(result.categories) && result.categories.length ? result.categories : FALLBACK_CATEGORIES;
    let nextCategory = latestRef.current.category;
    const pending = pendingCategoryRef.current;
    if (pending && nextCategories.some((item) => item.id === pending)) nextCategory = pending;
    if (!nextCategories.some((item) => item.id === nextCategory)) {
      const recalled = recallSurveyCategory(routeMetaRef.current?.attemptId);
      if (recalled && nextCategories.some((item) => item.id === recalled)) nextCategory = recalled;
    }
    if (!nextCategories.some((item) => item.id === nextCategory)) nextCategory = nextCategories[0].id;
    pendingCategoryRef.current = "";
    return { categories: nextCategories, category: nextCategory };
  };

  const load = async () => {
    if (loadInProgressRef.current) return; // 进行中互斥：防 online 恢复与初始加载/重试并发同题双发
    const routeMeta = routeMetaRef.current;
    if (!routeMeta) return;
    loadInProgressRef.current = true;
    if (!unloadedRef.current) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await getQuestionnaire(routeMeta.assignmentId);
      if (unloadedRef.current) return;
      // R31：已提交终态不可再进，toast 后落回任务详情（只读回跳保留任务来源）。
      if (result.attempt.status === "submitted") {
        toast("该任务已提交，不能回看问卷内容");
        replace(`/task?assignmentId=${encodeURIComponent(routeMeta.assignmentId)}&source=${sourceRef.current}`);
        return;
      }
      // R32：服务端 attempt/版本与路由不符。
      if (result.attempt.id !== routeMeta.attemptId || result.questionnaireVersion.id !== routeMeta.questionnaireVersionId) {
        throw new Error("问卷信息已更新，请从任务详情重新进入");
      }
      const nextMeta = { ...routeMeta, revision: result.attempt.revision };
      const serverAnswers = result.answers || {};
      const rawLocal = peekDraft(nextMeta);
      const merged = mergeSurveyAnswers({ serverAnswers, serverRevision: nextMeta.revision, rawLocal });
      const nextAnswers = merged.answers;
      const hasConflict = merged.conflict;
      routeMetaRef.current = nextMeta;
      const dishes = result.dishes || [];
      const highlight = result.otherRecords?.highlight || "";
      const suggestion = result.otherRecords?.suggestion || "";
      const categoryState = applyCategories(result);
      if (unloadedRef.current) return;
      if (hasConflict) {
        // R35：冲突时不覆盖本地待同步草稿；保留本地值供用户重试，只更新页面视图 + 冲突横幅。
        routeMetaRef.current = nextMeta;
        setMeta(nextMeta);
        setQuestions(result.questions);
        putAnswers(nextAnswers);
        setCategories(categoryState.categories);
        setCategory(categoryState.category);
        setConflict(true);
        setLoading(false);
        setSyncMessage("内容已更新，请刷新后重试");
        return;
      }
      saveDraft(nextMeta, { answers: nextAnswers, dishes, highlight, suggestion });
      // T3：补发成功前不得标记已同步——仍有待补发题时草稿保持 synced:false（刷新后可续补）。
      pendingResyncRef.current = new Set(merged.pendingResync);
      if (merged.pendingResync.length === 0) {
        markDraftSynced(nextMeta, nextMeta.revision);
      }
      routeMetaRef.current = nextMeta;
      setMeta(nextMeta);
      setQuestions(result.questions);
      putAnswers(nextAnswers);
      setCategories(categoryState.categories);
      setCategory(categoryState.category);
      setConflict(false);
      setLoading(false);
      setSyncMessage("");
      // R36：逐项补发——同 revision 合并后仍有本地未同步的得分答案时，按题号顺序重新保存到服务端。
      if (merged.pendingResync.length > 0) {
        let conflictDuringResync = false;
        for (const questionId of pendingQuestionOrder(merged.pendingResync, result.questions)) {
          if (unloadedRef.current) return;
          try {
            const saved = await saveAnswer(nextMeta.attemptId, questionId, { answer: "scored", revision: routeMetaRef.current.revision });
            if (unloadedRef.current) return;
            routeMetaRef.current = { ...routeMetaRef.current, revision: saved.revision };
            pendingResyncRef.current.delete(questionId);
            if (pendingResyncRef.current.size === 0) {
              markDraftSynced(routeMetaRef.current, saved.revision); // 全部补发完成才整体置已同步
            } else {
              advanceDraftRevision(routeMetaRef.current, saved.revision); // 部分成功：仅推进已知 revision
            }
            setMeta(routeMetaRef.current);
            setSyncMessage("正在恢复未保存的答案…");
          } catch (resyncError) {
            if (unloadedRef.current) return;
            if (resyncError?.kind === "conflict") {
              // revision 冲突不得继续用旧 revision 硬发：转 R35 既有冲突横幅链路（retry() 重新 load）。
              conflictDuringResync = true;
              setConflict(true);
              setSyncMessage("内容已更新，请刷新后重试");
              break;
            }
            /* 其他失败保留本地草稿（synced:false），下次进入或网络恢复再补发 */
          }
        }
        if (!unloadedRef.current && !conflictDuringResync) setSyncMessage("");
      }
    } catch (loadError) {
      if (unloadedRef.current) return;
      if (loadError?.kind === "session") {
        toast(loadError.message);
        redirectToLogin();
        return;
      }
      setLoading(false);
      setError(loadError?.message || "暂时无法加载问卷，请重试");
    } finally {
      loadInProgressRef.current = false;
    }
  };

  loadRef.current = load;

  // onLoad 等价：四参数校验（revision 缺省 0，R32）。
  useEffect(() => {
    // StrictMode 双挂载：重挂载恢复 false；真实卸载仍由 cleanup 置 true。
    unloadedRef.current = false;
    const params = routeQuery();
    const assignmentId = params.get("assignmentId") || "";
    const attemptId = params.get("attemptId") || "";
    const questionnaireVersionId = params.get("questionnaireVersionId") || "";
    if (!assignmentId || !attemptId || !questionnaireVersionId) {
      setLoading(false);
      setError("未找到问卷，请从任务详情重新进入");
      return () => { unloadedRef.current = true; };
    }
    routeMetaRef.current = {
      assignmentId,
      attemptId,
      questionnaireVersionId,
      revision: Number(params.get("revision") || 0),
    };
    // 任务来源（返回任务详情→首页/日程链路）；非法值由 sanitize 归一为 schedule。
    sourceRef.current = sanitizeTaskSource(params.get("source") || "");
    setMeta(routeMetaRef.current);
    // 路由指定的分类要等服务端分类列表返回后再校验（分类可由管理员扩展，R33）。
    pendingCategoryRef.current = params.get("category") || "";
    // 无路由分类时先恢复会话内记忆的选中分类（Issue 往返/浏览器后退/刷新重挂载不丢当前
    // 分类；服务端列表返回后仍校验，无效则按 R33 落回首个分类）。不预置会被组件初值
    //（首个兜底分类，恰好是合法分类）短路，记忆永远不被消费。
    if (!pendingCategoryRef.current) {
      const recalled = recallSurveyCategory(routeMetaRef.current.attemptId);
      if (recalled) {
        latestRef.current.category = recalled;
        setCategory(recalled);
      }
    }
    load();
    return () => { unloadedRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 网络恢复按序补发：重新走 load()（拉取+合并+补发），不做后台队列；并发由 load 互斥兜底。
  useEffect(() => {
    const handleOnline = () => {
      if (unloadedRef.current) return;
      loadRef.current?.();
    };
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, []);

  // 同文档路由的 category 查询变化（浏览器前进后退/外部跳转；业务键刻意不含 category）：
  // 不重挂载、不打断在途保存，直接应用到当前分类。经服务端分类列表校验（R33），无效分类
  // 保留当前有效选择；与 applyCategorySelection 幂等（自身 replace 引发的 prop 变化被
  // 「与当前一致即跳过」短路，不会回退用户点选）。
  useEffect(() => {
    if (!routeCategory || unloadedRef.current) return;
    if (routeCategory === latestRef.current.category) return;
    if (!(latestRef.current.categories || []).some((item) => item.id === routeCategory)) return;
    setCategory(routeCategory);
    rememberSurveyCategory(routeMetaRef.current?.attemptId, routeCategory);
  }, [routeCategory]);

  const retry = () => {
    if (!routeMetaRef.current) return; // 参数缺失的阻断错误无重试意义
    setConflict(false);
    load();
  };

  // 派生视图（等价 miniapp project()，R39 完成度口径：只统计当前题目集合内的答案）。
  const visible = useMemo(
    () => questions
      .filter((item) => item.category === category)
      .map((item) => ({ ...item, isScoreWipe: Boolean(item.isScoreWipe), current: answers[item.id] || null, expanded: Boolean(expanded[item.id]) })),
    [questions, category, answers, expanded],
  );
  const answeredCount = useMemo(() => {
    const questionIds = new Set(questions.map((item) => item.id));
    return Object.keys(answers).filter((id) => questionIds.has(id)).length;
  }, [questions, answers]);
  const lastCategory = categories[categories.length - 1];
  const isLastCategory = Boolean(lastCategory) && category === lastCategory.id;

  // 选中分类落地三件事：组件态、会话级记忆、规范 URL（replace 原位同步，不加历史）。
  // URL 里的 category 若不同步，返回/直达重建时旧参数会盖掉用户实际所选（R33 校验仍在）。
  const applyCategorySelection = (id) => {
    setCategory(id);
    rememberSurveyCategory(routeMetaRef.current?.attemptId, id);
    const raw = String(window.location.hash || "");
    if (!raw.startsWith("#/survey")) return;
    const [path, query = ""] = raw.slice(1).split("?");
    const search = new URLSearchParams(query);
    if ((search.get("category") || "") === id) return;
    search.set("category", id);
    replace(`#${path}?${search.toString()}`);
  };

  const selectCategory = (id) => applyCategorySelection(id);

  // 纯视图：题干展开/收起。
  const toggleExpand = (id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));

  // openIssue（等价 miniapp navigateTo，6 参 + source/category）：问题页兜底返回问卷时
  // 需要完整来源链与当前分类（分类仅为路由参数，不进草稿身份）。
  const openIssue = (questionId, target) => {
    const current = routeMetaRef.current;
    navigate(`/issue?assignmentId=${encodeURIComponent(current.assignmentId)}&attemptId=${encodeURIComponent(current.attemptId)}&questionnaireVersionId=${encodeURIComponent(current.questionnaireVersionId)}&revision=${current.revision}&questionId=${encodeURIComponent(questionId)}&target=${target}&source=${sourceRef.current}&category=${encodeURIComponent(latestRef.current.category)}`);
  };

  // 分数清零题「是」二次确认（等价 miniapp wx.showModal；web 端惯例 window.confirm，参考 OtherPage R80）。
  const confirmWipeThenIssue = (questionId) => {
    if (window.confirm("确认存在该严重问题？确认后本类目全部题目不得分。")) openIssue(questionId, "unscored");
  };

  // 得分作答（R37 乐观更新；R38 当前答案 unscored 时点「得分」改走编辑会话）。
  const score = async (questionId) => {
    const current = latestRef.current.answers[questionId];
    if (current?.answer === "unscored") {
      openIssue(questionId, "scored");
      return;
    }
    const previous = current;
    const nextAnswers = { ...latestRef.current.answers, [questionId]: { answer: "scored", remark: "", attachments: [] } };
    putAnswers(nextAnswers);
    setSyncMessage("正在保存…");
    saveDraft(routeMetaRef.current, { answers: nextAnswers }); // 本地先行（R37）
    try {
      const result = await saveAnswer(routeMetaRef.current.attemptId, questionId, { answer: "scored", revision: routeMetaRef.current.revision });
      if (unloadedRef.current) return;
      routeMetaRef.current = { ...routeMetaRef.current, revision: result.revision };
      if (pendingResyncRef.current.size === 0) {
        markDraftSynced(routeMetaRef.current, result.revision); // 无遗留待补发题才整体置已同步
      } else {
        advanceDraftRevision(routeMetaRef.current, result.revision); // 有遗留：仅推进已知 revision
      }
      setMeta(routeMetaRef.current);
      setSyncMessage("已保存");
    } catch (saveError) {
      if (unloadedRef.current) return;
      pendingResyncRef.current.add(questionId); // 保存失败：本地草稿仍存该题，留在待补发集合
      // 失败回滚到点击前的旧答案（无旧答案则删除该键）。
      const reverted = { ...nextAnswers };
      if (previous) reverted[questionId] = previous;
      else delete reverted[questionId];
      putAnswers(reverted);
      setSyncMessage("保存失败，请重试");
      toast(saveError?.message || "保存失败，请重试");
    }
  };

  // 返回任务详情（问卷的规范父页）：上一条应用内历史确为同任务详情才原生后退（不产生
  // bounce 条目）；否则 replace 携来源的任务 URL。无路由参数（直达缺参）落首页。
  const backToTask = () => {
    const current = routeMetaRef.current;
    if (!current) {
      replace("/home");
      return;
    }
    const taskUrl = `/task?assignmentId=${encodeURIComponent(current.assignmentId)}&source=${sourceRef.current}`;
    back(taskUrl, (previous) => navEntryIsPage(previous, "/task", { assignmentId: current.assignmentId }));
  };

  // 进菜品页全题守卫（R40）：有未完成题 → 切到该分类 + toast 阻断；全完成 → 带 4 参数进入。
  const goDishes = () => {
    const missing = firstIncompleteQuestion(latestRef.current.questions, latestRef.current.answers);
    if (missing) {
      applyCategorySelection(missing.category);
      toast(`请先完成第 ${missing.number} 题`);
      return;
    }
    const current = routeMetaRef.current;
    navigate(`/dishes?assignmentId=${encodeURIComponent(current.assignmentId)}&attemptId=${encodeURIComponent(current.attemptId)}&questionnaireVersionId=${encodeURIComponent(current.questionnaireVersionId)}&revision=${current.revision}&source=${sourceRef.current}`);
  };

  const viewState = loading ? "loading" : error ? "error" : "ready";

  return (
    <div className="app-page app-page--flat" data-page="survey" data-state={viewState} data-conflict={conflict ? "true" : "false"}>
      <PageNav title="暗访问卷" onBack={backToTask} />
      {/* 三步流程条：第 1 步 active（§1.7 a.1） */}
      <FlowSteps current="survey" />

      {loading ? (
        <Card><Muted>正在加载问卷…</Muted></Card>
      ) : error ? (
        <Card>
          <div className="inline-error">{error}</div>
          {routeMetaRef.current ? (
            <div style={{ marginTop: 12 }}>
              <Button onClick={retry}>重新加载</Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          {/* 冲突横幅（R35）：不覆盖本地，提供重新加载（§1.7 c） */}
          {conflict ? (
            <div className="error-bar" role="status">
              <span>问卷内容已在其他位置更新，为避免覆盖已有记录，请刷新后继续。</span>
              <button type="button" className="error-bar__retry" onClick={retry}>重新加载</button>
            </div>
          ) : null}

          {/* 分类 tab（§1.7 a.2 / R33） */}
          <div className="filter-chips">
            {categories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={`chip ${cat.id === category ? "chip--active" : ""}`}
                onClick={() => selectCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* 进度文案（§1.7 a.3 / R39：分母为当前题目总数） */}
          <div style={{ fontSize: 13, color: "#70747b", marginBottom: 8 }}>
            已完成 {answeredCount} / {questions.length} 题{syncMessage ? ` · ${syncMessage}` : ""}
          </div>

          {/* 题目卡列表（§1.7 a.5） */}
          {visible.map((question) => (
            <Card key={question.id}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontWeight: 600 }}>第 {question.number} 题</span>
                <Button variant="link" small onClick={() => toggleExpand(question.id)}>
                  {question.expanded ? "收起" : "查看全部"}
                </Button>
              </div>
              <div style={{
                marginTop: 6,
                fontSize: 14,
                lineHeight: 1.6,
                ...(question.expanded ? {} : { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, overflow: "hidden" }),
              }}>
                {question.text}
              </div>
              {/* 分数清零题标签（钉死文案）：警示选「是」将整类清零 */}
              {question.isScoreWipe ? (
                <div style={{ marginTop: 6 }}>
                  <span style={{ fontSize: 12, color: "#f25f42" }}>本题选「是」将清零本类全部得分</span>
                </div>
              ) : null}
              {/* 不得分摘要（等价 miniapp issue-summary：显示问题说明） */}
              {question.current?.answer === "unscored" ? (
                <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span className="tag">不得分</span>
                  {question.current.remark ? (
                    <span style={{ fontSize: 12, color: "#70747b" }}>{question.current.remark}</span>
                  ) : null}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {/* 计分选择按钮：未选=白底橙红字+橙红边（outline），选中=橙红底白字（primary）。
                    以真实持久化作答状态渲染（而非默认得分），aria-pressed 表达选中语义。 */}
                <Button
                  small
                  variant={question.current?.answer === "scored" ? "primary" : "outline"}
                  aria-pressed={question.current?.answer === "scored"}
                  data-answer-state={question.current?.answer === "scored" ? "selected" : "unselected"}
                  onClick={() => score(question.id)}
                >
                  {question.isScoreWipe ? "否" : "得分"}
                </Button>
                <Button
                  small
                  variant={question.current?.answer === "unscored" ? "primary" : "outline"}
                  aria-pressed={question.current?.answer === "unscored"}
                  data-answer-state={question.current?.answer === "unscored" ? "selected" : "unselected"}
                  onClick={() => (question.isScoreWipe ? confirmWipeThenIssue(question.id) : openIssue(question.id, "unscored"))}
                >
                  {question.isScoreWipe ? "是" : "不得分"}
                </Button>
              </div>
            </Card>
          ))}

          {/* 最后一类才显示下一步（等价 miniapp wx:if isLastCategory） */}
          {isLastCategory ? (
            <Button block onClick={goDishes}>下一步：其他照片</Button>
          ) : null}
        </>
      )}
    </div>
  );
}
