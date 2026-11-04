-- Brands: used on products and as a browse filter. Sellers add one by typing its name;
-- admins can deactivate bad ones.

CREATE TABLE brands (
  id          UUID         PRIMARY KEY DEFAULT uuidv7(),

  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(120) NOT NULL,
  logo_url    TEXT,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,

  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,

  CONSTRAINT brands_name_not_blank CHECK (BTRIM(name) <> ''),
  CONSTRAINT brands_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX brands_name_unique ON brands (LOWER(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX brands_slug_unique ON brands (slug) WHERE deleted_at IS NULL;

CREATE TRIGGER brands_set_updated_at
BEFORE UPDATE ON brands
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
