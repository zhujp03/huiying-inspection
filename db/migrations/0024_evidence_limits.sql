-- 题目证据配置扩展：每题可配置照片上限（默认 3 张）与录音时长上限（默认 10 秒）。
-- 存量数据由默认值自动兼容；CHECK 保证配置范围（照片 1-9 张、录音 1-60 秒）。
ALTER TABLE question_evidence_requirements
  ADD COLUMN image_max_count integer NOT NULL DEFAULT 3 CHECK (image_max_count BETWEEN 1 AND 9),
  ADD COLUMN audio_max_duration_seconds integer NOT NULL DEFAULT 10 CHECK (audio_max_duration_seconds BETWEEN 1 AND 60);
