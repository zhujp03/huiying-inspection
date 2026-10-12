export async function lockCampaignAndAssignments(client, campaignId) {
  const campaign = await client.query("SELECT * FROM audit_campaigns WHERE id=$1 FOR UPDATE", [campaignId]);
  if (!campaign.rows[0]) return { campaign: null, assignments: [] };
  const assignments = await client.query("SELECT * FROM audit_assignments WHERE campaign_id=$1 ORDER BY id FOR UPDATE", [campaignId]);
  return { campaign: campaign.rows[0], assignments: assignments.rows };
}

// 逾期待推进 campaign 的批量选择（worker 轮询用；谓词必须与 advanceCampaignOverdue 的逾期判定一致：
// assigned 看探店截止 due_at，in_progress 看问卷最终截止 questionnaire_deadline_at（回退 due_at），
// 避免"命中选择却无状态可推进"的 campaign 长期占满 LIMIT 名额、饿死真正需推进的 campaign）。
export async function selectOverdueCampaigns(client, limit = 100) {
  const campaigns = await client.query(`SELECT c.id FROM audit_campaigns c
    WHERE c.status IN ('published','in_progress') AND EXISTS (
      SELECT 1 FROM audit_assignments a WHERE a.campaign_id=c.id AND (
        (a.status='assigned' AND a.due_at<=now())
        OR (a.status='in_progress' AND COALESCE(a.questionnaire_deadline_at,a.due_at)<=now())
      )
    ) ORDER BY c.id FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
  return campaigns.rows.map((row) => row.id);
}

export async function advanceCampaignOverdue(client, campaignId) {
  const locked = await lockCampaignAndAssignments(client, campaignId);
  if (!locked.campaign || ["draft", "completed", "cancelled"].includes(locked.campaign.status)) return locked;
  // 逾期判定：未开始探店的按探店截止（due_at）；已开始的按问卷最终截止（deadline，兼容旧数据回退 due_at）
  const overdue = locked.assignments.filter((assignment) => {
    if (!["assigned", "in_progress"].includes(assignment.status)) return false;
    if (assignment.status === "assigned") return new Date(assignment.due_at) <= new Date();
    const deadline = assignment.questionnaire_deadline_at || assignment.due_at;
    return new Date(deadline) <= new Date();
  });
  for (const assignment of overdue) await client.query("UPDATE audit_assignments SET status='overdue',revision=revision+1,updated_at=now() WHERE id=$1", [assignment.id]);
  const statuses = locked.assignments.map((assignment) => overdue.some((item) => item.id === assignment.id) ? "overdue" : assignment.status);
  const nextStatus = statuses.every((status) => ["submitted", "cancelled"].includes(status)) ? "completed"
    : statuses.every((status) => status === "assigned") ? "published"
      : "in_progress";
  const campaignChanged = overdue.length > 0 || nextStatus !== locked.campaign.status;
  if (campaignChanged) await client.query("UPDATE audit_campaigns SET status=$2,completed_at=CASE WHEN $2='completed' THEN now() ELSE completed_at END,revision=revision+1,updated_at=now() WHERE id=$1", [campaignId, nextStatus]);
  return {
    campaign: { ...locked.campaign, status: nextStatus, revision: Number(locked.campaign.revision) + (campaignChanged ? 1 : 0) },
    assignments: locked.assignments.map((assignment) => {
      const changed = overdue.some((item) => item.id === assignment.id);
      return { ...assignment, status: changed ? "overdue" : assignment.status, revision: Number(assignment.revision) + (changed ? 1 : 0), overdueAdvanced: changed };
    }),
  };
}
