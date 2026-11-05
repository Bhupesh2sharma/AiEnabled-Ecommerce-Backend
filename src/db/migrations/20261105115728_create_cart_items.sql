-- Cart: a customer's cart is just their rows here, one per variant.
-- Prices aren't stored, so a cart always shows the current price, and stock isn't held until an order
-- is placed. Variants are soft deleted, so a removed variant's row stays and shows as unavailable.
-- The limit of 50 items per cart, and customers only, are enforced in the app.

CREATE TABLE cart_items (
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  variant_id  UUID        NOT NULL REFERENCES product_variants (id) ON DELETE CASCADE,

  quantity    INTEGER     NOT NULL,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (user_id, variant_id),

  CONSTRAINT cart_items_quantity_range CHECK (quantity BETWEEN 1 AND 10)
);

-- The primary key covers lookups by user. This is for deleting a variant, which must find its cart rows.
CREATE INDEX cart_items_variant_id_idx ON cart_items (variant_id);

CREATE TRIGGER cart_items_set_updated_at
BEFORE UPDATE ON cart_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
