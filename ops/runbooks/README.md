# Runbooks

No runtime command may silently fall back to fixtures. 所有演练必须使用 staging 独立环境，禁止连接生产短信、验证码、小程序域名或生产数据库。

- [PostgreSQL backup and recovery](backup-recovery.md)
- [COS object reconciliation](cos-reconciliation.md)
- [Database unavailable](database-outage.md)
- [COS unavailable](cos-outage.md)
- [OCR backlog](ocr-backlog.md)
- [SMS incident](sms-incident.md)
- [Credential rotation](key-rotation.md)
- [Submission invariant violation](submission-invariant.md)
- [Accidental object deletion recovery](object-restore.md)
