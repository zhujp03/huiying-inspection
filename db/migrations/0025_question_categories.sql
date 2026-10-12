-- 问卷评估分类可由管理员扩展：新增分类表，题目/答题进度的分类列从固定枚举 CHECK 改为外键引用。
-- 内置种子即现有三个分类（code 沿用旧枚举值），存量题目与进行中问卷无需数据迁移。
CREATE TABLE question_categories (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO question_categories (id, code, name, sort_order) VALUES
  (gen_random_uuid(), 'environment', '环境卫生', 1),
  (gen_random_uuid(), 'service', '为客服务', 2),
  (gen_random_uuid(), 'product', '产品品质', 3);

ALTER TABLE questions DROP CONSTRAINT questions_category_check;
ALTER TABLE questions ADD CONSTRAINT questions_category_fk FOREIGN KEY (category) REFERENCES question_categories(code) ON DELETE RESTRICT;
ALTER TABLE survey_attempts DROP CONSTRAINT survey_attempts_current_category_check;
ALTER TABLE survey_attempts ADD CONSTRAINT survey_attempts_current_category_fk FOREIGN KEY (current_category) REFERENCES question_categories(code) ON DELETE RESTRICT;
CREATE INDEX question_categories_sort_idx ON question_categories(sort_order, code);
