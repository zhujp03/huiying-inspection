-- 品牌实体：门店按「城市 -> 品牌 -> 门店」组织，支持后台联动筛选与后续品牌维度统计。
-- brand_id 保持可空：存量门店由管理员在后台补挂品牌后逐步收敛为必填。
CREATE TABLE brands (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stores ADD COLUMN brand_id uuid REFERENCES brands(id) ON DELETE RESTRICT;
CREATE INDEX stores_brand_idx ON stores(brand_id);
