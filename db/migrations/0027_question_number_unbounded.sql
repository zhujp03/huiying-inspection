-- 草稿问卷题目管理：题量不设上限，题号仍须从 1 起连续（1..N），仅去掉 50 的硬上限。
ALTER TABLE questions DROP CONSTRAINT questions_question_number_check;
ALTER TABLE questions ADD CONSTRAINT questions_question_number_check CHECK (question_number >= 1);
