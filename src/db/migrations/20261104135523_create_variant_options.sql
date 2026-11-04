-- Variant options: the choices a product variant can have, such as Size or Colour, defined by admins
-- so a new option needs no code change. Variants store the codes, so labels can be renamed safely.

CREATE TABLE variant_options (
  id                   UUID        PRIMARY KEY DEFAULT uuidv7(),

  name                 VARCHAR(50) NOT NULL,  -- shown to customers, e.g. "Size"; can be renamed
  code                 VARCHAR(50) NOT NULL,  -- e.g. size; the app must not change it after creation
  allow_custom_values  BOOLEAN     NOT NULL DEFAULT FALSE,  -- lets sellers type their own value

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,

  CONSTRAINT variant_options_name_not_blank CHECK (BTRIM(name) <> ''),
  CONSTRAINT variant_options_code_format CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX variant_options_code_unique ON variant_options (code) WHERE deleted_at IS NULL;

CREATE TRIGGER variant_options_set_updated_at
BEFORE UPDATE ON variant_options
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The allowed values of an option, such as S, M, L.
CREATE TABLE variant_option_values (
  id          UUID        PRIMARY KEY DEFAULT uuidv7(),
  option_id   UUID        NOT NULL REFERENCES variant_options (id) ON DELETE CASCADE,

  label       VARCHAR(50) NOT NULL,  -- shown to customers, e.g. "Medium"; can be renamed
  code        VARCHAR(50) NOT NULL,  -- e.g. m; the app must not change it after creation
  color_hex   CHAR(7),               -- optional colour swatch, e.g. #FF0000
  sort_order  INTEGER     NOT NULL DEFAULT 0,  -- so sizes show S, M, L rather than alphabetically

  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,

  CONSTRAINT variant_option_values_label_not_blank CHECK (BTRIM(label) <> ''),
  CONSTRAINT variant_option_values_code_format CHECK (code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT variant_option_values_color_hex_format CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$')
);

CREATE UNIQUE INDEX variant_option_values_code_unique
  ON variant_option_values (option_id, code) WHERE deleted_at IS NULL;

CREATE TRIGGER variant_option_values_set_updated_at
BEFORE UPDATE ON variant_option_values
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which options each category uses. Sub-categories also use their parents' options (handled in the app).
CREATE TABLE category_variant_options (
  category_id  UUID        NOT NULL REFERENCES categories (id) ON DELETE CASCADE,
  option_id    UUID        NOT NULL REFERENCES variant_options (id) ON DELETE RESTRICT,

  is_required  BOOLEAN     NOT NULL DEFAULT TRUE,  -- every variant must choose a value
  sort_order   INTEGER     NOT NULL DEFAULT 0,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (category_id, option_id)
);

CREATE INDEX category_variant_options_option_id_idx ON category_variant_options (option_id);
