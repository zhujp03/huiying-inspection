import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSrc } from "../helpers/contract-paths.js";

// H5 镜像模块：utils/business.js（契约 docs/web/module-contracts.md §5.2）。
// 期望值全部硬编码，逐条对照小程序源码 apps/miniapp/miniprogram/utils/business.js（只读校准）。
const business = await loadSrc("utils/business.js");

const { secureUuid, validateDish, firstIncompleteQuestion, isBlankExtraDish } = business;

// 合法已点样例菜（business.js:12-24 分支的公共基底）。
const sampleDish = {
  requirementId: "requirement-one",
  required: true,
  allowSubstitution: true,
  actualName: "招牌菜",
  fulfillmentStatus: "ordered",
  substitutionReason: "",
  unavailableReason: "",
  evaluation: "",
  fullySatisfied: true,
};

describe("validateDish（business.js:12-24，逐分支）", () => {
  it("合法已点菜返回空串", () => {
    expect(validateDish(sampleDish)).toBe("");
  });

  it(":14 必点菜选未点 → 拒绝", () => {
    expect(validateDish({ ...sampleDish, fulfillmentStatus: "skipped" })).toBe("必点菜品不能选择未点");
  });

  it(":15 已点菜保留替代或售罄原因 → 拒绝（空白原因按 trim 放行）", () => {
    expect(validateDish({ ...sampleDish, substitutionReason: "原菜缺货换了" })).toBe("已点菜品不能保留替代或售罄原因");
    expect(validateDish({ ...sampleDish, unavailableReason: "当日售罄" })).toBe("已点菜品不能保留替代或售罄原因");
    expect(validateDish({ ...sampleDish, substitutionReason: " " })).toBe("");
  });

  it(":16 不允许替代的菜选了替代 → 拒绝", () => {
    expect(validateDish({ ...sampleDish, fulfillmentStatus: "substituted", substitutionReason: "原菜售罄", allowSubstitution: false })).toBe("该菜品不允许替代");
  });

  it(":17 替代缺实际菜名或缺替代原因 → 拒绝", () => {
    expect(validateDish({ ...sampleDish, fulfillmentStatus: "substituted", substitutionReason: "原菜售罄", actualName: " " })).toBe("请填写替代菜名和替代原因");
    expect(validateDish({ ...sampleDish, fulfillmentStatus: "substituted", actualName: "替代菜", substitutionReason: "" })).toBe("请填写替代菜名和替代原因");
  });

  it(":17+valid 合法替代通过", () => {
    expect(validateDish({ ...sampleDish, fulfillmentStatus: "substituted", substitutionReason: "原菜售罄", actualName: "替代菜" })).toBe("");
  });

  it(":18 售罄：带实际菜名/带评价/带全满意或缺售罄原因 → 拒绝；清空后通过", () => {
    const unavailableBase = { ...sampleDish, fulfillmentStatus: "unavailable", actualName: "", evaluation: "", fullySatisfied: false, unavailableReason: "当日售罄" };
    expect(validateDish(unavailableBase)).toBe("");
    expect(validateDish({ ...unavailableBase, actualName: "招牌菜" })).toBe("售罄时请清空实际菜名和评价，并填写售罄原因");
    expect(validateDish({ ...unavailableBase, evaluation: "太咸了" })).toBe("售罄时请清空实际菜名和评价，并填写售罄原因");
    expect(validateDish({ ...unavailableBase, fullySatisfied: true })).toBe("售罄时请清空实际菜名和评价，并填写售罄原因");
    expect(validateDish({ ...unavailableBase, unavailableReason: " " })).toBe("售罄时请清空实际菜名和评价，并填写售罄原因");
  });

  it(":19 未点：带实际菜名/带评价/带全满意 → 拒绝；全空通过", () => {
    const skippedBase = { ...sampleDish, required: false, fulfillmentStatus: "skipped", actualName: "", evaluation: "", fullySatisfied: false };
    expect(validateDish(skippedBase)).toBe("");
    expect(validateDish({ ...skippedBase, actualName: "招牌菜" })).toBe("未点菜品不填写实际菜名和评价");
    expect(validateDish({ ...skippedBase, evaluation: "没点不评价" })).toBe("未点菜品不填写实际菜名和评价");
    expect(validateDish({ ...skippedBase, fullySatisfied: true })).toBe("未点菜品不填写实际菜名和评价");
  });

  it(":20 额外菜带 requirementId → 拒绝；去掉后继续走后续校验", () => {
    expect(validateDish({ ...sampleDish, requirementId: "requirement-one", required: false, fulfillmentStatus: "extra" })).toBe("额外菜品状态不正确");
  });

  it(":21 已点/替代/额外缺实际菜名 → 拒绝", () => {
    expect(validateDish({ ...sampleDish, actualName: "" })).toBe("请填写实际菜名");
    expect(validateDish({ ...sampleDish, requirementId: null, required: false, fulfillmentStatus: "extra", actualName: "" })).toBe("请填写实际菜名");
  });

  it(":22 已点/替代/额外未全满意且缺评价 → 拒绝；填评价或全满意后通过", () => {
    expect(validateDish({ ...sampleDish, fullySatisfied: false })).toBe("请填写评价或选择全部满意");
    expect(validateDish({ ...sampleDish, requirementId: null, required: false, fulfillmentStatus: "extra", fullySatisfied: false })).toBe("请填写评价或选择全部满意");
    expect(validateDish({ ...sampleDish, fullySatisfied: false, evaluation: "出品稳定" })).toBe("");
  });
});

describe("firstIncompleteQuestion（business.js:26-44）", () => {
  const sampleQuestions = [
    { id: "q1", number: 1, category: "environment", evidence: {} },
    { id: "q2", number: 2, category: "environment", evidence: { imageRequired: true, audioRequired: true } },
  ];

  it("缺号兜底：返回缺号 + 第一题的分类", () => {
    const gapped = [
      { id: "q1", number: 1, category: "hygiene", evidence: {} },
      { id: "q3", number: 3, category: "hygiene", evidence: {} },
    ];
    expect(firstIncompleteQuestion(gapped, {})).toEqual({ number: 2, category: "hygiene" });
  });

  it("缺号兜底：第一题无分类字段时回退 environment", () => {
    const gapped = [{ id: "q1", number: 1 }, { id: "q3", number: 3 }];
    expect(firstIncompleteQuestion(gapped, {})).toEqual({ number: 2, category: "environment" });
  });

  it("未答题：返回第一道缺失答案的题目", () => {
    expect(firstIncompleteQuestion(sampleQuestions, {})).toEqual(sampleQuestions[0]);
    expect(firstIncompleteQuestion(sampleQuestions, { q1: { answer: "scored" } })).toEqual(sampleQuestions[1]);
  });

  it("unscored 缺备注（含纯空白备注）→ 未完成", () => {
    const answers = { q1: { answer: "scored" }, q2: { answer: "unscored", remark: "" } };
    expect(firstIncompleteQuestion(sampleQuestions, answers)).toEqual(sampleQuestions[1]);
    expect(firstIncompleteQuestion(sampleQuestions, { ...answers, q2: { answer: "unscored", remark: " " } })).toEqual(sampleQuestions[1]);
  });

  it("unscored 缺必填图片/音频附件 → 未完成（active 且非 pendingRemoval 才算有效）", () => {
    const base = { q1: { answer: "scored" }, q2: { answer: "unscored", remark: "地面有油污" } };
    expect(firstIncompleteQuestion(sampleQuestions, base)).toEqual(sampleQuestions[1]);
    expect(firstIncompleteQuestion(sampleQuestions, {
      ...base, q2: { ...base.q2, attachments: [{ type: "image", status: "active" }] },
    })).toEqual(sampleQuestions[1]);
    // pendingRemoval 的图片不算有效证据
    expect(firstIncompleteQuestion(sampleQuestions, {
      ...base, q2: { ...base.q2, attachments: [{ type: "image", status: "active", pendingRemoval: true }] },
    })).toEqual(sampleQuestions[1]);
    // 非 active 的附件不算有效证据
    expect(firstIncompleteQuestion(sampleQuestions, {
      ...base, q2: { ...base.q2, attachments: [{ type: "image", status: "removed" }, { type: "audio", status: "removed" }] },
    })).toEqual(sampleQuestions[1]);
    // 图片、音频齐备 → 完成
    expect(firstIncompleteQuestion(sampleQuestions, {
      ...base, q2: { ...base.q2, attachments: [{ type: "image", status: "active" }, { type: "audio", status: "active" }] },
    })).toBeUndefined();
  });

  it("scored 答案不要求备注与附件；非法作答视为未完成；全部完成返回 undefined", () => {
    const bothScored = { q1: { answer: "scored" }, q2: { answer: "scored" } };
    expect(firstIncompleteQuestion(sampleQuestions, bothScored)).toBeUndefined();
    expect(firstIncompleteQuestion(sampleQuestions, { q1: { answer: "maybe" }, q2: { answer: "scored" } })).toEqual(sampleQuestions[0]);
  });
});

describe("isBlankExtraDish（business.js:46-53）", () => {
  const blankExtra = { fulfillmentStatus: "extra", actualName: "", evaluation: "", substitutionReason: "", unavailableReason: "", fullySatisfied: false };

  it("全空额外菜为 true（空白字符按 trim 判空）", () => {
    expect(isBlankExtraDish(blankExtra)).toBe(true);
    expect(isBlankExtraDish({ ...blankExtra, actualName: " " })).toBe(true);
  });

  it("任一字段非空或全满意为 true 反例 → false", () => {
    expect(isBlankExtraDish({ ...blankExtra, actualName: "加份甜品" })).toBe(false);
    expect(isBlankExtraDish({ ...blankExtra, evaluation: "好吃" })).toBe(false);
    expect(isBlankExtraDish({ ...blankExtra, substitutionReason: "换菜" })).toBe(false);
    expect(isBlankExtraDish({ ...blankExtra, unavailableReason: "售罄" })).toBe(false);
    expect(isBlankExtraDish({ ...blankExtra, fullySatisfied: true })).toBe(false);
  });

  it("非 extra 状态一律 false", () => {
    expect(isBlankExtraDish({ ...blankExtra, fulfillmentStatus: "ordered", actualName: "", evaluation: "" })).toBe(false);
  });
});

describe("secureUuid（business.js:1-10）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("输出 UUIDv4 格式（8-4-4-4-12、version 4、variant 8/9/a/b）且多次调用不重复", () => {
    const v4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const generated = Array.from({ length: 50 }, () => secureUuid());
    for (const value of generated) {
      expect(value).toMatch(v4Pattern);
    }
    expect(new Set(generated).size).toBe(50);
  });

  it("无安全随机源时 throw SECURE_RANDOM_UNAVAILABLE（business.js:5）", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => secureUuid()).toThrow("SECURE_RANDOM_UNAVAILABLE");
  });
});
