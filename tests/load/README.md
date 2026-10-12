# P1 load tests

`p1-api.k6.js` targets a real API and PostgreSQL environment. It does not start the API, create users, or use fixtures. Provide a non-production inspector account with active assignments and run it only after the environment, database pool, monitoring, and alert routing have been checked.

Before any P1 result is accepted, create an authorized, untracked JSON plan outside this repository and run the preflight. The plan must contain 100 distinct inspector credentials, 20 distinct administrator Cookie/CSRF sessions, 50 distinct answer-write attempts, 30 distinct ready-to-submit attempts, one 20-way idempotency replay, 20 already-uploaded attachment-complete payloads, 10 OCR jobs containing 1–3 receipt IDs, and 100/500 concrete administrator mutation requests. It must never contain production credentials or be committed.

```sh
P1_PLAN_PATH=/secure/staging-p1-plan.json npm run preflight:p1
```

The preflight prints counts only; it never prints tokens, cookies, IDs, object keys, or raw plan content. It verifies the declared staging-data cardinalities before k6 is started; it does not call the API, prove that the listed objects exist, execute a write scenario, or constitute a load result.

Run each stateful acceptance profile once against disposable, real staging data. The script never synthesizes an identifier, Cookie, CSRF token, attachment, signed upload, or business payload.

```sh
k6 run -e P1_PROFILE=p1_answer_writes -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_submit_burst -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_submit_replay -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_attachment_complete -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_ocr_burst -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_campaign_concentrated -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_campaign_publication -e P1_PLAN_PATH=/secure/staging-p1-plan.json -e API_BASE_URL=https://staging.example.com tests/load/p1-api.k6.js
```

The three duration profiles (`p1_30rps`, `p1_100rps`, and `p1_20rps`) also require `P1_PLAN_PATH`, rotate real inspector and administrator identities, and assert the normal read latency target. Stateful profiles tag each request by operation and enforce the 500 ms normal-write / 2 s submit P95 thresholds. Export raw k6 JSON and the independently collected database lock, pool, event-loop, worker, CPU, and memory metrics with every run.

```sh
k6 run -e API_BASE_URL=https://staging.example.com -e INSPECTOR_TOKEN=... tests/load/p1-api.k6.js
k6 run -e P1_PROFILE=p1_30rps -e API_BASE_URL=https://staging.example.com -e INSPECTOR_TOKEN=... tests/load/p1-api.k6.js
```

Profiles are `smoke`, `p1_30rps` (30 RPS for 30 minutes), `p1_100rps` (100 RPS for 60 seconds), and `p1_20rps` (20 RPS for 2 hours). The script refuses production-looking host names unless `ALLOW_PRODUCTION_LOAD=yes` is supplied deliberately.

Archive each raw k6 JSON report with the tested API/worker image digests, database sizing, pool limits, test data size, P50/P95/P99, error-code distribution, lock waits, CPU, memory, and the first failing level. This script is not evidence that P1 or staging capacity has passed.
