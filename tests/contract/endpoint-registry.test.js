import { describe, expect, it } from "vitest";
import { flatEndpoints } from "../../packages/contracts/endpoint-registry.js";
import { API } from "../../packages/contracts/index.js";
import { API as miniApi } from "../../apps/miniapp/miniprogram/services/contracts.generated.js";

describe("endpoint registry", () => {
  it("contains the mandated method/path pairs and projects the same client paths", () => {
    const endpoints = flatEndpoints();
    expect(endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "POST", path: "/api/auth/register" }),
      expect.objectContaining({ method: "POST", path: "/api/questionnaires/secret/:id/submit" }),
      expect.objectContaining({ method: "POST", path: "/api/admin/submissions/:id/attachments/:attachmentId/restore" }),
      expect.objectContaining({ method: "POST", path: "/api/admin/questionnaire-versions/:id/questions" }),
      expect.objectContaining({ method: "DELETE", path: "/api/admin/questionnaire-versions/:id/questions/:questionId" }),
      expect.objectContaining({ method: "POST", path: "/api/admin/questionnaire-versions/:id/questions/:questionId/move" }),
      expect.objectContaining({ method: "GET", path: "/api/admin/stats/dashboard" }),
    ]));
    expect(miniApi.assignments.start("assignment")).toBe(API.assignments.start("assignment"));
    expect(miniApi.drafts.receiptOcrApply("attempt", "job")).toBe(API.drafts.receiptOcrApply("attempt", "job"));
  });
});
