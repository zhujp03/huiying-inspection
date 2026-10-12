# COS object reconciliation

## Scope and schedule

The worker runs one reconciliation sample per policy version and UTC day when COS is configured. It takes an advisory lease, selects active question-evidence attachments and `ready` receipt attachments in deterministic daily order, then performs a version-aware COS `HEAD` and content SHA-256 verification outside the database transaction.

The resulting `object_reconciliation_runs` row stores only counts and a stable error code. It does not copy COS object keys, attachment metadata, or OCR content into application logs.

## Alert and response

Alert immediately when a run has `status=failed`, `mismatch_count>0`, or when no successful run exists for the current UTC day after the worker's scheduled window.

1. Stop deletion and storage-migration jobs; keep the original attachment rows immutable.
2. Use restricted database and COS operator access to identify the affected attachment IDs. Do not expose object keys or signed URLs in tickets or alerts.
3. Check the recorded COS version, object size, and SHA-256 against the private object. Preserve the mismatching version before any remediation.
4. Restore only through the approved COS version/backup procedure, then allow the next worker run to produce a new successful record.
5. Record the affected count, root cause, recovery version, and approval. Escalate any confirmed loss to the incident owner.

## Verification boundary

The automated test covers matching and mismatch paths and proves that a mismatch does not mutate a `ready` receipt attachment. This repository has no production COS credential, bucket, scheduled worker artifact, or reconciliation record. Production reconciliation and the associated alert delivery remain pending those authorized external resources.
