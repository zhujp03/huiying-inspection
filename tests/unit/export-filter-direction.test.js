import { describe, expect, it } from "vitest";
import { buildSubmissionExportFilterConditions, ExportRequestSchema, SUBMISSION_EXPORT_FILTER_RULES } from "../../packages/contracts/index.js";
import { runExportJobs } from "../../apps/worker/src/export-jobs.js";

// 红绿灯：导出筛选方向统一（>= 修正为 <=），列表与导出共享同一筛选构造
const SCOPE_ALL = JSON.stringify([{ scope_type: "all" }]);
const A_UUID = "01900000-0000-7000-8000-000000000001";
const A_TIME = "2026-10-01T00:00:00.000Z";
const MAX_ROWS = 10_001;

const exportJob = (filters) => ({
  id: A_UUID,
  job_kind: "submissions",
  requested_by: A_UUID,
  scope_snapshot_json: [{ scope_type: "all" }],
  filters_json: { kind: "submissions", filters },
});

// mock pool：捕获 SQL 文本与参数；claimJobs 返回目标 job，submissionRows 返回空行集
function capturePool(job) {
  const queries = [];
  const claim = { rows: [job], rowCount: 1 };
  return {
    queries,
    async connect() {
      return {
        query: async (text, params) => {
          queries.push({ text: String(text), params });
          return String(text).includes("FROM candidates") ? claim : { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
    async query(text, params) {
      queries.push({ text: String(text), params });
      return { rows: [], rowCount: 1 };
    },
  };
}

const cos = { putExportObject: async () => {}, deleteExportObject: async () => {} };

const submissionRowsQuery = async (filters) => {
  const pool = capturePool(exportJob(filters));
  await runExportJobs({ pool, cos });
  return pool.queries.find((query) => query.text.includes("FROM submission_versions submission"));
};

describe("导出筛选方向统一", () => {
  it("共享规则：maxIssueCount 为 <=，三个 id 为 =，submittedAfter 为 >=，submittedBefore 为 <=", () => {
    expect(SUBMISSION_EXPORT_FILTER_RULES.maxIssueCount).toMatchObject({ column: "submission.issue_count", op: "<=" });
    expect(SUBMISSION_EXPORT_FILTER_RULES.campaignId).toMatchObject({ column: "campaign.id", op: "=" });
    expect(SUBMISSION_EXPORT_FILTER_RULES.storeId).toMatchObject({ column: "store.id", op: "=" });
    expect(SUBMISSION_EXPORT_FILTER_RULES.inspectorId).toMatchObject({ column: "inspector.id", op: "=" });
    expect(SUBMISSION_EXPORT_FILTER_RULES.submittedAfter).toMatchObject({ column: "submission.submitted_at", op: ">=" });
    expect(SUBMISSION_EXPORT_FILTER_RULES.submittedBefore).toMatchObject({ column: "submission.submitted_at", op: "<=" });
    expect(Object.isFrozen(SUBMISSION_EXPORT_FILTER_RULES)).toBe(true);
  });

  it("构造器：maxIssueCount 输出 <=，空 filters 输出 []，键序与规则定义序一致", () => {
    expect(buildSubmissionExportFilterConditions({ maxIssueCount: 2 })).toEqual([{ column: "submission.issue_count", op: "<=", value: 2 }]);
    expect(buildSubmissionExportFilterConditions({})).toEqual([]);
    expect(buildSubmissionExportFilterConditions({ maxIssueCount: 2, submittedBefore: A_TIME, campaignId: A_UUID }).map((item) => item.column))
      .toEqual(["campaign.id", "submission.submitted_at", "submission.issue_count"]);
  });

  it("契约严格模式：接受 maxIssueCount，拒绝旧键 issueCountAtLeast", () => {
    expect(ExportRequestSchema.safeParse({ filters: { maxIssueCount: 2 } }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ filters: { issueCountAtLeast: 2 } }).success).toBe(false);
  });

  it("worker SQL 方向：新键 maxIssueCount 走 issue_count <= 且不含 >=", async () => {
    const query = await submissionRowsQuery({ maxIssueCount: 2 });
    expect(query.text).toMatch(/issue_count\s*<=/);
    expect(query.text).not.toMatch(/issue_count\s*>=/);
  });

  it("worker SQL 方向：旧键 issueCountAtLeast 同义收敛为 <=", async () => {
    const query = await submissionRowsQuery({ issueCountAtLeast: 2 });
    expect(query.text).toMatch(/issue_count\s*<=/);
    expect(query.text).not.toMatch(/issue_count\s*>=/);
  });

  it("worker SQL 方向：不含不得分数时不出现 issue_count 比较", async () => {
    const query = await submissionRowsQuery({ campaignId: A_UUID });
    expect(query.text).not.toMatch(/issue_count\s*(<=|>=|=)/);
  });

  it("worker SQL 方向：混合筛选下占位符编号与参数数组一一对应", async () => {
    const query = await submissionRowsQuery({ campaignId: A_UUID, submittedAfter: A_TIME, maxIssueCount: 2 });
    expect(query.params.slice(0, 2)).toEqual([SCOPE_ALL, null]);
    expect(query.params.slice(2, -1)).toEqual([A_UUID, A_TIME, 2]);
    expect(query.params.at(-1)).toBe(MAX_ROWS);
    const placeholders = [...new Set(query.text.match(/\$\d+/g).map((token) => Number(token.slice(1))))].sort((a, b) => a - b);
    expect(placeholders).toEqual(query.params.map((_, index) => index + 1));
  });
});
