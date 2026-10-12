// 轻量可观测性：Prometheus 文本格式 /metrics（无额外依赖）。
// 指标只含聚合/脱敏值：不出现手机号、用户名、对象 Key、request body 或签名 URL。
import { performance } from "node:perf_hooks";

const buckets = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

export function createMetrics() {
  const counters = new Map();   // key: `${name}${labelsJSON}` → count
  const histograms = new Map(); // key: `${name}${labelsJSON}` → { count, sum, buckets[] }
  const inc = (name, labels = {}) => {
    const key = `${name}${JSON.stringify(labels)}`;
    counters.set(key, (counters.get(key) || 0) + 1);
  };
  const observe = (name, seconds, labels = {}) => {
    const key = `${name}${JSON.stringify(labels)}`;
    const entry = histograms.get(key) || { count: 0, sum: 0, buckets: new Array(buckets.length).fill(0) };
    entry.count += 1;
    entry.sum += seconds;
    for (let index = 0; index < buckets.length; index += 1) if (seconds <= buckets[index]) entry.buckets[index] += 1;
    histograms.set(key, entry);
  };
  const requestStart = () => performance.now();
  const requestEnd = (startedAt, statusCode, routeName) => {
    const seconds = (performance.now() - startedAt) / 1000;
    const codeBucket = statusCode < 400 ? "2xx_3xx" : statusCode < 500 ? "4xx" : "5xx";
    inc("http_requests_total", { status: codeBucket, route: routeName || "unknown" });
    observe("http_request_duration_seconds", seconds, { route: routeName || "unknown" });
  };
  const serialise = () => {
    const counterEntries = {};
    for (const [key, value] of counters) {
      const labelsStart = key.indexOf("{");
      counterEntries[key.slice(labelsStart === -1 ? key.length : labelsStart)] = value;
    }
    const histogramEntries = {};
    for (const [key, entry] of histograms) {
      const labelsStart = key.indexOf("{");
      histogramEntries[key.slice(labelsStart === -1 ? key.length : labelsStart)] = { count: entry.count, sum: entry.sum, buckets: [...entry.buckets] };
    }
    return { counters: counterEntries, histograms: histogramEntries };
  };
  return Object.freeze({ inc, observe, requestStart, requestEnd, serialise });
}

const push = (lines, name, type, help, samples) => {
  lines.push(`# TYPE ${name} ${type}`);
  if (help) lines.push(`# HELP ${name} ${help}`);
  for (const [labels, value] of samples) {
    const labelText = Object.entries(labels).map(([key, value]) => `${key}="${String(value).replace(/"/g, "\\\"")}"`).join(",");
    lines.push(`${name}${labelText ? `{${labelText}}` : ""} ${typeof value === "number" && Number.isInteger(value) ? value : Number(value).toFixed(6)}`);
  }
};

export async function renderMetrics({ pool, metrics, startedAt }) {
  const lines = [];
  const serialised = metrics.serialise();
  const counterSamples = Object.entries(serialised.counters).map(([labelsJSON, value]) => [JSON.parse(labelsJSON), value]);
  push(lines, "http_requests_total", "counter", "HTTP requests by status class and route", counterSamples);
  const histogramSamples = [];
  const summarySamples = [];
  for (const [labelsJSON, entry] of Object.entries(serialised.histograms)) {
    const labels = JSON.parse(labelsJSON);
    histogramSamples.push([{ ...labels, le: "+Inf" }, entry.count]);
    for (let index = 0; index < buckets.length; index += 1) histogramSamples.push([{ ...labels, le: String(buckets[index]) }, entry.buckets[index]]);
    summarySamples.push([{ ...labels, quantile: "0.5" }, entry.buckets.length ? summaryQuantile(entry, 0.5) : 0]);
    summarySamples.push([{ ...labels, quantile: "0.95" }, entry.buckets.length ? summaryQuantile(entry, 0.95) : 0]);
    summarySamples.push([{ ...labels, quantile: "0.99" }, entry.buckets.length ? summaryQuantile(entry, 0.99) : 0]);
    summarySamples.push([{ ...labels }, entry.sum]);
    summarySamples.push([{ ...labels }, entry.count]);
  }
  push(lines, "http_request_duration_seconds_bucket", "histogram", "HTTP latency buckets", histogramSamples);
  push(lines, "http_request_duration_seconds", "summary", "HTTP latency summary (seconds)", summarySamples);
  const memory = process.memoryUsage();
  push(lines, "process_rss_bytes", "gauge", "Process resident set size", [[{}, memory.rss]]);
  push(lines, "process_heap_used_bytes", "gauge", "V8 heap used", [[{}, memory.heapUsed]]);
  const eventLoopDelay = await measureEventLoopDelay();
  push(lines, "event_loop_delay_seconds", "gauge", "Event loop delay (sampled per scrape)", [[{}, eventLoopDelay]]);
  push(lines, "process_uptime_seconds", "gauge", "Process uptime", [[{}, process.uptime()]]);
  if (pool) {
    const poolStats = { waitingCount: pool.waiting || 0, idleCount: pool.idle || 0, totalCount: pool.total || 0 };
    push(lines, "database_pool_waiting_count", "gauge", "Connections waiting for a pool slot", [[{}, poolStats.waitingCount]]);
    push(lines, "database_pool_idle_count", "gauge", "Idle pooled connections", [[{}, poolStats.idleCount]]);
    push(lines, "database_pool_total_count", "gauge", "Total pooled connections", [[{}, poolStats.totalCount]]);
    try {
      const submissionStates = await pool.query("SELECT status, count(*)::int count FROM idempotency_keys WHERE scope='questionnaire_submit' GROUP BY status");
      push(lines, "submissions_total", "gauge", "Submission idempotency states", submissionStates.rows.map((row) => [{ status: row.status }, row.count]));
      const ocrQueue = await pool.query("SELECT status, count(*)::int count FROM receipt_ocr_jobs WHERE status IN ('queued','processing') GROUP BY status");
      push(lines, "ocr_queue_depth", "gauge", "OCR queue depth by status", ocrQueue.rows.map((row) => [{ status: row.status }, row.count]));
      const ocrAge = await pool.query("SELECT COALESCE(EXTRACT(EPOCH FROM max(now()-created_at)), 0) age_seconds FROM receipt_ocr_jobs WHERE status IN ('queued','processing')");
      push(lines, "ocr_queue_oldest_age_seconds", "gauge", "Oldest OCR job age", [[{}, ocrAge.rows[0]?.age_seconds || 0]]);
      const backups = await pool.query("SELECT max(completed_at) completed_at FROM system_job_runs WHERE job='database_backup'");
      const backupAge = backups.rows[0]?.completed_at ? (Date.now() - new Date(backups.rows[0].completed_at).getTime()) / 1000 : -1;
      push(lines, "backup_age_seconds", "gauge", "Age of latest database backup (-1 when never)", [[{}, backupAge]]);
      const retentionLag = await pool.query("SELECT COALESCE(EXTRACT(EPOCH FROM max(now()-completed_at)), -1) lag_seconds FROM system_job_runs WHERE job='retention'");
      push(lines, "retention_lag_seconds", "gauge", "Seconds since last retention run", [[{}, retentionLag.rows[0]?.lag_seconds || -1]]);
      const heartbeat = await pool.query("SELECT COALESCE(EXTRACT(EPOCH FROM max(now()-heartbeat_at)), -1) age_seconds FROM system_job_runs WHERE job='worker_heartbeat'");
      push(lines, "worker_heartbeat_age_seconds", "gauge", "Seconds since worker heartbeat", [[{}, heartbeat.rows[0]?.age_seconds || -1]]);
    } catch { push(lines, "database_metrics_unavailable", "gauge", "Database-derived metrics unavailable", [[{}, 1]]); }
  }
  lines.push(`# junde_api_started_seconds ${Math.floor(startedAt / 1000)}`);
  return lines.join("\n") + "\n";
}

const summaryQuantile = (entry, q) => {
  const total = entry.count;
  const target = total * q;
  for (let index = 0; index < buckets.length; index += 1) {
    if (entry.buckets[index] >= target) {
      const lower = index === 0 ? 0 : buckets[index - 1];
      const upper = buckets[index];
      return lower + (upper - lower) * 0.5;
    }
  }
  return buckets.at(-1);
};

const measureEventLoopDelay = () => new Promise((resolve) => {
  const started = performance.now();
  setTimeout(() => resolve((performance.now() - started) / 1000 - 0.001), 5);
});
