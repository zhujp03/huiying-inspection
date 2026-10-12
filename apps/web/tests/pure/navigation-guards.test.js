// C 类纯逻辑测试：router/guards.js（module-contracts §6.2；语义来源 utils/auth.js:3-8、api.js:42、login/index.js:58-66）。
// 契约：requireApprovedSession(session) / coldStartRoute(session) / handleUnauthorized()。
// - requireApprovedSession：session?.user?.status === "approved_active" 且有 accessToken → { ok: true, session }（session 同对象）；
//   否则 { ok: false, redirect: "/login" }（R02，wx.reLaunch 改为纯判定 + redirect 由调用方执行）。
// - coldStartRoute：有 approved 会话 → "/home"；否则 "/login"（R03 冷启动探测分流）。
// - handleUnauthorized：清会话与用户缓存（等价 clearSessionAndUserCache + 任务缓存清空，R05），返回 "/login" 供路由层跳转。
//
// TDD 红灯基线：apps/web/src/router/guards.js 等模块尚未实现，本文件全部用例预期因模块不存在而失败。
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { loadSrc } from "../helpers/contract-paths.js";

const SAMPLE_SESSION = {
  user: { id: "user-sample-a", status: "approved_active", displayName: "探员甲" },
  accessToken: "sample-token",
};

describe("router/guards.js requireApprovedSession（R02 导航守卫）", () => {
  it("approved_active + accessToken → { ok: true, session } 且 session 为同一对象", async () => {
    const { requireApprovedSession } = await loadSrc("router/guards.js");
    const sampleSession = { ...SAMPLE_SESSION };
    const result = requireApprovedSession(sampleSession);
    assert.deepEqual(result, { ok: true, session: sampleSession });
    assert.equal(result.session, sampleSession, "session 应为传入的同一对象（同引用）");
  });

  it("status 非 approved_active（pending_approval / rejected）→ { ok: false, redirect: \"/login\" }", async () => {
    const { requireApprovedSession } = await loadSrc("router/guards.js");
    for (const status of ["pending_approval", "rejected"]) {
      const result = requireApprovedSession({ user: { id: "user-sample-a", status }, accessToken: "sample-token" });
      assert.deepEqual(result, { ok: false, redirect: "/login" });
    }
  });

  it("缺 accessToken / session 为 null → { ok: false, redirect: \"/login\" }", async () => {
    const { requireApprovedSession } = await loadSrc("router/guards.js");
    assert.deepEqual(
      requireApprovedSession({ user: { id: "user-sample-a", status: "approved_active" } }),
      { ok: false, redirect: "/login" },
    );
    assert.deepEqual(requireApprovedSession(null), { ok: false, redirect: "/login" });
  });
});

describe("router/guards.js coldStartRoute（R03 冷启动探测分流）", () => {
  it("有 approved 会话 → \"/home\"", async () => {
    const { coldStartRoute } = await loadSrc("router/guards.js");
    assert.equal(coldStartRoute(SAMPLE_SESSION), "/home");
  });

  it("无 approved 会话（pending / 缺 token / null）→ \"/login\"", async () => {
    const { coldStartRoute } = await loadSrc("router/guards.js");
    assert.equal(coldStartRoute({ user: { id: "user-sample-a", status: "pending_approval" }, accessToken: "sample-token" }), "/login");
    assert.equal(coldStartRoute({ user: { id: "user-sample-a", status: "approved_active" } }), "/login");
    assert.equal(coldStartRoute(null), "/login");
  });
});

describe("router/guards.js handleUnauthorized（R05 401 统一登出）", () => {
  it("清会话、按索引清当前用户草稿并返回 \"/login\"；其他用户草稿不受影响", async () => {
    const storage = await loadSrc("adapters/storage.js");
    const sessionStore = await loadSrc("store/session.js");
    const { handleUnauthorized } = await loadSrc("router/guards.js");

    // 铺样例状态：当前用户会话 + 两用户的草稿索引与草稿本体（契约 §4.1 / §2.2）。
    const sampleDraftKey = "junde:survey:user-sample-a:assignment-a:attempt-a:version-a";
    const otherDraftKey = "junde:survey:user-sample-b:assignment-b:attempt-b:version-b";
    sessionStore.saveSession(SAMPLE_SESSION);
    sessionStore.registerDraftKey("user-sample-a", sampleDraftKey);
    sessionStore.registerDraftKey("user-sample-b", otherDraftKey);
    storage.writeStorage(sampleDraftKey, { answers: {}, revision: 1 });
    storage.writeStorage(otherDraftKey, { answers: {}, revision: 1 });

    assert.equal(handleUnauthorized(), "/login");
    assert.equal(sessionStore.getSession(), null, "会话应被清空（getSession 返回 null）");

    const draftIndex = storage.readStorage("junde:draft-index") || {};
    assert.equal(
      Object.prototype.hasOwnProperty.call(draftIndex, "user-sample-a"),
      false,
      "junde:draft-index 应已无当前用户的索引项",
    );
    assert.equal(storage.readStorage(sampleDraftKey), null, "当前用户草稿本体应被逐键删除");

    assert.deepEqual(draftIndex["user-sample-b"], [otherDraftKey], "其他用户的草稿索引项不受影响（R05 边界）");
    assert.notEqual(storage.readStorage(otherDraftKey), null, "其他用户的草稿本体不受影响");
  });
});
