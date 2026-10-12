# Runbook: OCR backlog（小票识别堆积）

影响：`ocr_queue_depth` 与 `ocr_queue_oldest_age_seconds` 上升；SLO 为 95% 任务 120 秒内得到明确结果（最多 9 张单任务 10 分钟硬超时）。堆积不阻断手工录入，只影响自动带入体验。

## 检测
- 告警：最老 queued job > 10 分钟；`ocr_queue_depth` 接近 `OCR_MAX_QUEUED_JOBS`。
- 新任务入队超限时返回 503 `OCR_QUEUE_FULL`（可重试）。

## 处置
1. 确认 sidecar 健康：`GET /v1/health`；查看推理时长与 worker 日志。
2. 若 worker 处理慢：按 `OCR_WORKER_MAX_CONCURRENCY`（1–8，需内存预算）与 `OCR_WORKER_POLL_INTERVAL_MS` 调优；多个 worker 实例可同时领取（`FOR UPDATE SKIP LOCKED` + 租约）。
3. 若 sidecar 单点：扩容 OCR 实例并把 `OCR_SERVICE_URL` 指向负载均衡。
4. 长时间失败的任务会自动进入 `failed`（`OCR_JOB_MAX_ATTEMPTS` 后），原图与草稿保留，探店员可手工录入或显式重试。

## 验证
- 演练：制造 10 个 1–3 张小票任务同时入队 → 观察队列年龄回落与 `succeeded/partial` 完成率；worker 崩溃后租约到期可接管且候选不重复（`tests/integration/batch2.postgres.test.js` 覆盖）。

## 禁止
- 禁止自动回退腾讯付费 OCR；禁止 LLM 猜测小票内容。
