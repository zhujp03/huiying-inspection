import { getMyAssignments } from "../../services/api.js";
import { requireApprovedSession } from "../../utils/auth.js";
import { groupAssignmentsByDate } from "../../utils/presentation.js";

// 状态筛选：承接原问卷入口页的分段视图（可执行 / 等待 / 已完成），
// 日程页成为三 Tab 结构下唯一的任务全量入口。
const STATUS_FILTERS = [
  { value: "assigned", label: "待开始" },
  { value: "in_progress", label: "进行中" },
  { value: "overdue", label: "已逾期" },
  { value: "submitted", label: "已提交" },
];

Page({
  data: {
    groups: [], totalCount: 0,
    statusFilter: "", filterChips: [],
    loading: true, refreshing: false, error: "", errorBlocking: false, navigatingId: "",
  },
  async onShow() {
    if (!requireApprovedSession()) return;
    await this.load();
  },
  // 首次加载才显示骨架；已有内容时后台刷新保留旧内容，只显示顶部轻量更新状态。
  async load({ force = false } = {}) {
    const hasContent = this.data.groups.length > 0;
    this.setData({ loading: !hasContent, refreshing: force, error: "", errorBlocking: false });
    try {
      const result = await getMyAssignments({ force });
      this.allItems = result.items;
      this.applyFilter();
    } catch (error) {
      // 业务/网络错误自带中文文案；未预期的前端异常只记 Console，不把英文开发错误展示给探店员。
      console.error("日程任务加载失败", error);
      // 有旧内容 → 非阻塞错误条；无内容 → 完整错误态。
      this.setData({ error: error?.kind ? error.message : "暂时无法加载任务，请重试", errorBlocking: !hasContent });
    } finally {
      this.setData({ loading: false, refreshing: false });
    }
  },
  // 仅按状态过滤本地数据，不重新请求。
  applyFilter() {
    const items = this.allItems || [];
    const filter = this.data.statusFilter;
    const counts = {};
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    const filterChips = [{ value: "", label: "全部", count: items.length }]
      .concat(STATUS_FILTERS.filter((entry) => (counts[entry.value] || 0) > 0).map((entry) => ({ ...entry, count: counts[entry.value] })));
    const visible = filter ? items.filter((item) => item.status === filter) : items;
    this.setData({ filterChips, groups: groupAssignmentsByDate(visible), totalCount: visible.length });
  },
  filterStatus(event) {
    const value = event.currentTarget.dataset.status || "";
    if (value === this.data.statusFilter) return;
    this.setData({ statusFilter: value });
    this.applyFilter();
  },
  async onPullDownRefresh() {
    await this.load({ force: true });
    wx.stopPullDownRefresh();
  },
  retry() { if (this.data.refreshing) return; this.load({ force: true }); },
  goTask(event) {
    const id = event.currentTarget.dataset.id;
    if (this.data.navigatingId) return; // 防重复：跳转期间禁止再次触发
    this.setData({ navigatingId: id });
    wx.navigateTo({
      url: `/pages/task/index?assignmentId=${encodeURIComponent(id)}`,
      complete: () => this.setData({ navigatingId: "" }),
    });
  },
});
