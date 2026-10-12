# PostgreSQL backup and recovery

## Daily backup

Use a dedicated backup-role STS credential that can only write to `COS_BACKUP_BUCKET`; the API and normal worker role must not receive delete permission for that bucket.

```sh
BACKUP_EXECUTION_CONFIRM=yes \
DATABASE_URL='postgresql://...' \
COS_REGION=ap-shanghai COS_BACKUP_BUCKET='backup-...' \
COS_STS_SECRET_ID=... COS_STS_SECRET_KEY=... COS_STS_TOKEN=... COS_STS_EXPIRES_AT=... \
npm run ops:backup
```

The command creates a custom-format `pg_dump`, validates it with `pg_restore --list`, uploads it with a SHA-256 metadata value, then verifies the private COS object length and digest. Save the emitted JSON record with the scheduled-job log. A missing confirmation, database URL, backup bucket, credential, `pg_dump`, or `pg_restore` is a failure; no fallback artifact is accepted.

## Monthly isolated restore drill

Never restore into production. Create an isolated PostgreSQL 17 database with no production SMS, CAPTCHA, COS, admin domain, or worker process attached. Download one backup using the backup-only role, verify its SHA-256 against the recorded value, then run:

```sh
pg_restore --clean --if-exists --no-owner --no-privileges --dbname "$DRILL_DATABASE_URL" backup.dump
DATABASE_URL="$DRILL_DATABASE_URL" npm run db:migrate
```

Record the backup key/version, dump hash, restore start/end time, migration result, schema migration list, row-count sample, random `submission_versions.integrity_hash` sample, and a COS attachment version/sha256 sample. Start the API read-only for `/ready` and an authorized administrator sample before considering the drill successful.

## Incident recovery order

1. Stop API write traffic and all workers.
2. Establish isolated networking and restore the selected backup/PITR target.
3. Run migration checksum verification and the evidence-reference sample above.
4. Start API read-only and verify `/ready`; do not start workers yet.
5. Record RPO/RTO, data gap, and approval to switch traffic.
6. Start workers only after the new API instance is healthy, so stale leases are recovered exactly once.

This repository has no successful production backup or restore-drill artifact yet. Do not report the 24-hour RPO or 4-hour RTO as verified until the real scheduled backup and isolated drill records exist.
