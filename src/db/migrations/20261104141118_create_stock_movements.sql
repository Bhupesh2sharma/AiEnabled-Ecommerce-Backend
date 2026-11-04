-- History of every stock change, for answering "why is this stock wrong?" and resolving disputes.
-- Rows are only ever added. The orders and returns modules add more reasons later.

CREATE TYPE stock_movement_reason AS ENUM ('initial', 'restock', 'correction');

CREATE TABLE stock_movements (
  id              UUID                  PRIMARY KEY DEFAULT uuidv7(),
  variant_id      UUID                  NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,

  change          INTEGER               NOT NULL,  -- positive adds stock, negative removes it
  quantity_after  INTEGER               NOT NULL,  -- stock after this change
  reason          stock_movement_reason NOT NULL,
  note            VARCHAR(255),
  created_by      UUID                  REFERENCES users (id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ           NOT NULL DEFAULT NOW(),

  CONSTRAINT stock_movements_change_not_zero CHECK (change <> 0),
  CONSTRAINT stock_movements_quantity_after_non_negative CHECK (quantity_after >= 0)
);

CREATE INDEX stock_movements_variant_history_idx ON stock_movements (variant_id, created_at DESC);
