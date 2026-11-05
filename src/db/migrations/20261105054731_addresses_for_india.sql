-- Addresses for India: an exact state for tax, a checked PIN code, and real deletion.
--
-- state_code is what orders compare to choose CGST + SGST or IGST. `state` stays as the name, filled in
-- by the app from the code, so the two can't disagree. NOT NULL fails if rows exist, which is deliberate:
-- no endpoint has written addresses before this, and a state must not be guessed.
--
-- Deleting becomes a real delete. Orders copy the address, so nothing needs the old row, and keeping
-- home addresses nobody uses is a privacy risk. Dropping deleted_at also drops the indexes that use it.

ALTER TABLE addresses
  ADD COLUMN state_code CHAR(2) NOT NULL,
  ADD CONSTRAINT addresses_state_code_format CHECK (state_code ~ '^[0-9]{2}$'),
  ADD CONSTRAINT addresses_india_postal_code_format
    CHECK (country_code <> 'IN' OR postal_code ~ '^[1-9][0-9]{5}$'),
  ALTER COLUMN country_code SET DEFAULT 'IN',
  DROP COLUMN deleted_at;

CREATE INDEX addresses_user_id_idx ON addresses (user_id);

-- At most one default shipping and one default billing address per user
CREATE UNIQUE INDEX addresses_one_default_shipping ON addresses (user_id) WHERE is_default_shipping;
CREATE UNIQUE INDEX addresses_one_default_billing ON addresses (user_id) WHERE is_default_billing;
