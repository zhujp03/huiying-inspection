// Admin 前端路由表单测（纯函数，Node 环境直跑）：
// canonical 规整（根入口 → /admin/overview）、URL 映射/解析、未知路径拒绝、路径构造与
// render-static 深链接白名单同构性。
import { describe, expect, it } from "vitest";
import { adminPaths, canonicalPathname, resolveRoute, rootReplacement } from "../../apps/admin/src/routes.js";

describe("admin routes table", () => {
  it("maps the nine top-level pages with their permissions", () => {
    const expected = {
      overview: null, dashboard: "stats:read", campaigns: "campaign:manage", users: "user:manage",
      stores: "store:manage", questionnaires: "questionnaire:manage", submissions: "submission:read",
      exports: "export:create", audits: "audit:read",
    };
    for (const [page, permission] of Object.entries(expected)) {
      const route = resolveRoute(`/admin/${page}`);
      expect(route, page).toMatchObject({ page, screen: "list", permission });
    }
  });

  it("parses nested detail/edit screens with id params", () => {
    expect(resolveRoute("/admin/campaigns/campaign-one")).toMatchObject({ page: "campaigns", screen: "campaign-detail", params: { id: "campaign-one" } });
    expect(resolveRoute("/admin/campaigns/campaign-one/edit")).toMatchObject({ screen: "campaign-edit" });
    expect(resolveRoute("/admin/campaigns/campaign-one/assignments/assignment-one/edit")).toMatchObject({ screen: "assignment-edit", params: { id: "campaign-one", assignmentId: "assignment-one" } });
    expect(resolveRoute("/admin/campaigns/new")).toMatchObject({ screen: "campaign-new" });
    expect(resolveRoute("/admin/users/user-one/edit")).toMatchObject({ page: "users", screen: "user-edit", params: { id: "user-one" } });
    expect(resolveRoute("/admin/users/new?kind=admin")).toMatchObject({ screen: "user-new" });
    expect(resolveRoute("/admin/users/new?kind=admin").query.get("kind")).toBe("admin");
    expect(resolveRoute("/admin/stores/store-one/edit")).toMatchObject({ page: "stores", screen: "store-edit" });
    expect(resolveRoute("/admin/stores/new")).toMatchObject({ screen: "store-new" });
    expect(resolveRoute("/admin/questionnaires/version-draft")).toMatchObject({ page: "questionnaires", screen: "questionnaire-version", params: { id: "version-draft" } });
    expect(resolveRoute("/admin/questionnaires/new")).toMatchObject({ screen: "questionnaire-new" });
    expect(resolveRoute("/admin/submissions/submission-one")).toMatchObject({ page: "submissions", screen: "submission-detail", params: { id: "submission-one" } });
  });

  it("carries query params for tabs, wizard steps and question selection", () => {
    const tabRoute = resolveRoute("/admin/users?tab=registrations");
    expect(tabRoute.query.get("tab")).toBe("registrations");
    const wizardRoute = resolveRoute("/admin/campaigns/campaign-one/edit?step=2");
    expect(wizardRoute.query.get("step")).toBe("2");
    const questionRoute = resolveRoute("/admin/questionnaires/version-draft?question=draft-question-2&category=service");
    expect(questionRoute.query.get("question")).toBe("draft-question-2");
    expect(questionRoute.query.get("category")).toBe("service");
  });

  it("rejects unknown, malformed and non-admin paths", () => {
    for (const href of ["/admin/some/where", "/admin/campaigns/campaign-one/extra", "/admin/users/user-one", "/overview", "/admin/../secret", "/admin/overview/%2e%2e"]) {
      expect(resolveRoute(href), href).toBeNull();
    }
  });

  it("canonicalizes root entries to the overview route", () => {
    for (const pathname of ["/", "/admin", "/admin/", "/admin/index.html"]) {
      expect(canonicalPathname(pathname)).toBe("/admin/overview");
      expect(rootReplacement(pathname)).toBe("/admin/overview");
      expect(resolveRoute(pathname)).toMatchObject({ page: "overview" });
    }
    expect(rootReplacement("/admin/campaigns")).toBeNull();
    expect(canonicalPathname("/admin/campaigns/")).toBe("/admin/campaigns");
  });

  it("builds hrefs that resolve back to the same route", () => {
    const samples = [
      adminPaths.page("stores"), adminPaths.users("registrations"), adminPaths.users(), adminPaths.userNew("admin"),
      adminPaths.userEdit("user-one"), adminPaths.storeNew(), adminPaths.storeEdit("store-one"),
      adminPaths.campaigns(), adminPaths.campaignNew(), adminPaths.campaignDetail("campaign-one"),
      adminPaths.campaignEdit("campaign-one"), adminPaths.campaignEdit("campaign-one", 2), adminPaths.campaignEdit("campaign-one", 2, "list"),
      adminPaths.assignmentEdit("campaign-one", "assignment-one"), adminPaths.questionnaires(),
      adminPaths.questionnaireNew(), adminPaths.questionnaireDetail("version-draft", { question: "q2", category: "service" }),
      adminPaths.submissions(), adminPaths.submissionDetail("submission-one"),
    ];
    for (const href of samples) {
      expect(resolveRoute(href), href).not.toBeNull();
    }
    expect(adminPaths.campaignEdit("campaign-one")).toBe("/admin/campaigns/campaign-one/edit");
    expect(adminPaths.campaignEdit("campaign-one", 2)).toBe("/admin/campaigns/campaign-one/edit?step=2");
    // 向导进入来源：list 显式携带，detail 省略（默认），只作站内枚举、不充当跳转 URL。
    expect(adminPaths.campaignEdit("campaign-one", 2, "list")).toBe("/admin/campaigns/campaign-one/edit?step=2&from=list");
    expect(adminPaths.campaignEdit("campaign-one", 2, "detail")).toBe("/admin/campaigns/campaign-one/edit?step=2");
    expect(resolveRoute(adminPaths.campaignEdit("c1", 2, "list")).query.get("from")).toBe("list");
    expect(adminPaths.questionnaireDetail("v1", {})).toBe("/admin/questionnaires/v1");
    expect(adminPaths.userEdit("id with space")).toBe("/admin/users/id%20with%20space/edit");
  });
});
