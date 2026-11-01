-- Addresses: a user's saved shipping/billing addresses (address book).
-- Orders must COPY the address into the order when placed, so editing or
-- deleting an address later never changes where a past order was shipped.

CREATE TABLE addresses (
  id                   UUID         PRIMARY KEY DEFAULT uuidv7(),
  user_id              UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,

  label                VARCHAR(50),                  -- e.g. Home, Work, Warehouse

  -- Recipient (may differ from the account holder)
  full_name            VARCHAR(100) NOT NULL,
  phone                VARCHAR(20)  NOT NULL,        -- E.164 format, e.g. +919876543210

  -- Location
  address_line1        VARCHAR(255) NOT NULL,        -- house/flat no., building, street
  address_line2        VARCHAR(255),                 -- area, locality
  landmark             VARCHAR(255),
  city                 VARCHAR(100) NOT NULL,
  state                VARCHAR(100) NOT NULL,
  postal_code          VARCHAR(20)  NOT NULL,
  country_code         CHAR(2)      NOT NULL,        -- ISO 3166-1 alpha-2, e.g. IN, US

  -- Defaults used to pre-fill checkout
  is_default_shipping  BOOLEAN      NOT NULL DEFAULT FALSE,
  is_default_billing   BOOLEAN      NOT NULL DEFAULT FALSE,

  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,

  CONSTRAINT addresses_phone_format CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT addresses_country_code_format CHECK (country_code ~ '^[A-Z]{2}$')
);

CREATE INDEX addresses_user_id_idx ON addresses (user_id) WHERE deleted_at IS NULL;

-- At most one default shipping and one default billing address per user
CREATE UNIQUE INDEX addresses_one_default_shipping
  ON addresses (user_id) WHERE is_default_shipping AND deleted_at IS NULL;
CREATE UNIQUE INDEX addresses_one_default_billing
  ON addresses (user_id) WHERE is_default_billing AND deleted_at IS NULL;

CREATE TRIGGER addresses_set_updated_at
BEFORE UPDATE ON addresses
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
