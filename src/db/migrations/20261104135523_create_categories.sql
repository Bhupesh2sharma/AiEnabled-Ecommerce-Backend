-- Categories: an admin-managed tree, e.g. Electronics > Mobiles > Smartphones.
-- The 3-level limit and "products only on a category with no children" are enforced in the app.

CREATE TABLE categories (
  id                UUID         PRIMARY KEY DEFAULT uuidv7(),
  parent_id         UUID         REFERENCES categories (id) ON DELETE RESTRICT,  -- NULL = top level

  name              VARCHAR(100) NOT NULL,
  slug              VARCHAR(120) NOT NULL,   -- URL-friendly, e.g. /category/smartphones
  description       TEXT,
  image_url         TEXT,
  default_hsn_code  VARCHAR(8),              -- a suggestion for sellers only; they can change it

  sort_order        INTEGER      NOT NULL DEFAULT 0,
  is_active         BOOLEAN      NOT NULL DEFAULT TRUE,  -- inactive hides the category's products

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT categories_name_not_blank CHECK (BTRIM(name) <> ''),
  CONSTRAINT categories_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT categories_default_hsn_code_format
    CHECK (default_hsn_code IS NULL OR default_hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  CONSTRAINT categories_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE UNIQUE INDEX categories_slug_unique ON categories (slug) WHERE deleted_at IS NULL;

-- No two categories with the same name under one parent. NULLS NOT DISTINCT includes top-level categories.
CREATE UNIQUE INDEX categories_sibling_name_unique
  ON categories (parent_id, LOWER(name)) NULLS NOT DISTINCT WHERE deleted_at IS NULL;

CREATE INDEX categories_parent_id_idx ON categories (parent_id) WHERE deleted_at IS NULL;

CREATE TRIGGER categories_set_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
