-- Products: the listing customers see. What's actually bought is a row in product_variants.
-- Sellers can save incomplete drafts, but the database refuses to publish without the legal details.

-- Lets search tolerate typos, e.g. "cottn" finding "cotton".
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE product_status AS ENUM ('draft', 'active', 'paused');

CREATE TABLE products (
  id                    UUID           PRIMARY KEY DEFAULT uuidv7(),
  seller_id             UUID           NOT NULL REFERENCES seller_profiles (id) ON DELETE RESTRICT,
  category_id           UUID           NOT NULL REFERENCES categories (id) ON DELETE RESTRICT,
  brand_id              UUID           REFERENCES brands (id) ON DELETE RESTRICT,  -- NULL = unbranded

  title                 VARCHAR(200)   NOT NULL,
  slug                  VARCHAR(220)   NOT NULL,
  description           TEXT,
  highlights            TEXT[]         NOT NULL DEFAULT '{}',  -- short bullet points
  specifications        JSONB          NOT NULL DEFAULT '{}',  -- e.g. {"Material": "Cotton"}; display only

  -- India: GST and the details a listing must show
  hsn_code              VARCHAR(8),               -- required to publish if the seller has a GSTIN (checked in the app)
  generic_name          VARCHAR(150),             -- e.g. "Men's T-Shirt"
  country_of_origin     CHAR(2),                  -- ISO 3166-1 alpha-2, e.g. IN
  manufacturer_name     VARCHAR(200),
  manufacturer_address  TEXT,
  packer_details        TEXT,
  importer_details      TEXT,
  is_returnable         BOOLEAN        NOT NULL DEFAULT TRUE,
  return_window_days    SMALLINT       DEFAULT 7,
  warranty_summary      VARCHAR(255),

  status                product_status NOT NULL DEFAULT 'draft',
  min_price             NUMERIC(12, 2),           -- lowest live variant price, kept in sync by the app

  search_vector         TSVECTOR       GENERATED ALWAYS AS (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', COALESCE(generic_name, '')), 'B')
  ) STORED,

  -- Admin moderation, separate from status so a seller can't undo it
  blocked_at            TIMESTAMPTZ,
  blocked_by            UUID           REFERENCES users (id) ON DELETE SET NULL,
  blocked_reason        TEXT,

  created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,

  -- Lets product_variants prove a variant belongs to the same seller as its product
  CONSTRAINT products_id_seller_unique UNIQUE (id, seller_id),

  CONSTRAINT products_title_not_blank CHECK (BTRIM(title) <> ''),
  CONSTRAINT products_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT products_specifications_is_object CHECK (jsonb_typeof(specifications) = 'object'),
  CONSTRAINT products_hsn_code_format CHECK (hsn_code IS NULL OR hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  CONSTRAINT products_country_of_origin_format CHECK (country_of_origin IS NULL OR country_of_origin ~ '^[A-Z]{2}$'),
  CONSTRAINT products_return_window_required
    CHECK (NOT is_returnable OR (return_window_days IS NOT NULL AND return_window_days > 0)),
  CONSTRAINT products_min_price_positive CHECK (min_price IS NULL OR min_price > 0),
  CONSTRAINT products_legal_details_required CHECK (
    status = 'draft' OR (
      generic_name IS NOT NULL AND
      country_of_origin IS NOT NULL AND
      manufacturer_name IS NOT NULL AND
      manufacturer_address IS NOT NULL
    )
  ),
  CONSTRAINT products_blocked_reason_required CHECK (blocked_at IS NULL OR blocked_reason IS NOT NULL)
);

CREATE UNIQUE INDEX products_slug_unique ON products (slug) WHERE deleted_at IS NULL;

CREATE INDEX products_search_vector_idx ON products USING GIN (search_vector) WHERE deleted_at IS NULL;
CREATE INDEX products_title_trgm_idx ON products USING GIN (title gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX products_category_price_idx ON products (category_id, min_price) WHERE deleted_at IS NULL;
CREATE INDEX products_brand_id_idx ON products (brand_id) WHERE deleted_at IS NULL;
CREATE INDEX products_seller_id_idx ON products (seller_id) WHERE deleted_at IS NULL;

CREATE TRIGGER products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
