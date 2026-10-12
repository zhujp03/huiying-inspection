-- 分数清零题：该题作答 unscored 时，其所在分类的全部题目在提交计分中按 0 分计。
ALTER TABLE questions ADD COLUMN is_score_wipe boolean NOT NULL DEFAULT false;
