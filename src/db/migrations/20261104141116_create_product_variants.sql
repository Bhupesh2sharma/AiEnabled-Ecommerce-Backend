-- Variants: what's actually bought, one row per size/colour combination.
-- Every product has at least one; a product with no options has one variant with empty options.

CREATE TABLE product_variants (
  id                   UUID           PRIMARY KEY DEFAULT uuidv7(),
  product_id           UUID           NOT NULL,
  seller_id            UUID           NOT NULL,  -- copied from the product, so SKUs can be unique per seller

  sku                  VARCHAR(64)    NOT NULL,  -- the seller's own code
  options              JSONB          NOT NULL DEFAULT '{}',  -- option code -> value code, e.g. {"size": "m"}
  option_labels        JSONB          NOT NULL DEFAULT '{}',  -- labels for custom values only

  -- Rupees. selling_price includes GST.
  mrp                  NUMERIC(12, 2) NOT NULL,
  selling_price        NUMERIC(12, 2) NOT NULL,
  gst_rate             NUMERIC(5, 2)  NOT NULL DEFAULT 0,  -- per variant, because some rates depend on price

  -- Required to publish (checked in the app), so drafts can be saved without them
  net_quantity         VARCHAR(50),              -- e.g. "500 g", "1 N"
  weight_grams         INTEGER,
  length_mm            INTEGER,
  width_mm             INTEGER,
  height_mm            INTEGER,

  stock_quantity       INTEGER        NOT NULL DEFAULT 0,
  low_stock_threshold  INTEGER        NOT NULL DEFAULT 5,

  barcode              VARCHAR(20),              -- optional GTIN/EAN
  is_active            BOOLEAN        NOT NULL DEFAULT TRUE,

  created_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,

  FOREIGN KEY (product_id, seller_id) REFERENCES products (id, seller_id) ON DELETE CASCADE,

  -- Lets product_images prove an image's variant belongs to the same product
  CONSTRAINT product_variants_id_product_unique UNIQUE (id, product_id),

  CONSTRAINT product_variants_sku_not_blank CHECK (BTRIM(sku) <> ''),
  CONSTRAINT product_variants_options_is_object CHECK (jsonb_typeof(options) = 'object'),
  CONSTRAINT product_variants_option_labels_is_object CHECK (jsonb_typeof(option_labels) = 'object'),
  CONSTRAINT product_variants_mrp_positive CHECK (mrp > 0),
  CONSTRAINT product_variants_selling_price_positive CHECK (selling_price > 0),
  CONSTRAINT product_variants_selling_price_within_mrp CHECK (selling_price <= mrp),
  CONSTRAINT product_variants_gst_rate_range CHECK (gst_rate BETWEEN 0 AND 100),
  CONSTRAINT product_variants_weight_positive CHECK (weight_grams IS NULL OR weight_grams > 0),
  CONSTRAINT product_variants_dimensions_positive CHECK (
    (length_mm IS NULL OR length_mm > 0) AND
    (width_mm IS NULL OR width_mm > 0) AND
    (height_mm IS NULL OR height_mm > 0)
  ),
  CONSTRAINT product_variants_stock_non_negative CHECK (stock_quantity >= 0),
  CONSTRAINT product_variants_low_stock_non_negative CHECK (low_stock_threshold >= 0),
  CONSTRAINT product_variants_barcode_format CHECK (barcode IS NULL OR barcode ~ '^[0-9]{8,14}$')
);

CREATE UNIQUE INDEX product_variants_sku_unique
  ON product_variants (seller_id, LOWER(sku)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX product_variants_options_unique
  ON product_variants (product_id, options) WHERE deleted_at IS NULL;

-- For filters such as colour = red.
CREATE INDEX product_variants_options_idx
  ON product_variants USING GIN (options jsonb_path_ops) WHERE deleted_at IS NULL;

CREATE TRIGGER product_variants_set_updated_at
BEFORE UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
