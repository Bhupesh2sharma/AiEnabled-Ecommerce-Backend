-- Users table: one row per account (customer, seller or admin).
-- Seller business details, addresses and auth tokens live in their own tables.

CREATE TYPE user_role AS ENUM ('customer', 'seller', 'admin');
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended');

CREATE TABLE users (
  -- UUIDv7: time-ordered (index-friendly) and safe to expose in URLs, unlike 1, 2, 3...
  id                  UUID         PRIMARY KEY DEFAULT uuidv7(),

  -- Profile
  name                VARCHAR(100) NOT NULL,
  email               VARCHAR(255) NOT NULL,
  phone               VARCHAR(20),                 -- E.164 format, e.g. +919876543210
  avatar_url          TEXT,

  -- Auth
  password_hash       TEXT         NOT NULL,       -- bcrypt/argon2 hash, never the plain password
  role                user_role    NOT NULL DEFAULT 'customer',
  status              user_status  NOT NULL DEFAULT 'active',

  -- Verification: NULL = not verified, otherwise when it was verified
  email_verified_at   TIMESTAMPTZ,
  phone_verified_at   TIMESTAMPTZ,

  -- Consent
  terms_accepted_at   TIMESTAMPTZ  NOT NULL,       -- must accept terms to register
  terms_version       VARCHAR(20)  NOT NULL,       -- which version of the terms they accepted
  marketing_opt_in    BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Activity / security
  last_login_at       TIMESTAMPTZ,
  failed_login_count  INTEGER      NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,                 -- temporary lock after too many failed logins

  -- Timestamps
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ,                 -- soft delete: keep the row for order history

  CONSTRAINT users_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT users_phone_format CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT users_failed_login_count_non_negative CHECK (failed_login_count >= 0)
);

-- Case-insensitive unique email/phone, ignoring soft-deleted accounts so they can sign up again
CREATE UNIQUE INDEX users_email_unique ON users (LOWER(email)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX users_role_idx ON users (role) WHERE deleted_at IS NULL;

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
