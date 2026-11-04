-- Auth schema: allow password-less and email-less accounts, and add the tables
-- behind Google login, OTP codes and refresh-token sessions.

-- Google and phone users have no password; phone users may have no email.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users
  ADD CONSTRAINT users_email_or_phone_required CHECK (email IS NOT NULL OR phone IS NOT NULL);

-- External identities linked to a user. A table (not a column) so Apple/Facebook can be added later.
CREATE TYPE auth_provider AS ENUM ('google');

CREATE TABLE auth_providers (
  id                UUID          PRIMARY KEY DEFAULT uuidv7(),
  user_id           UUID          NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider          auth_provider NOT NULL,
  provider_user_id  VARCHAR(255)  NOT NULL,  -- the provider's stable id (Google "sub"), not the email
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT auth_providers_identity_unique UNIQUE (provider, provider_user_id),
  CONSTRAINT auth_providers_user_provider_unique UNIQUE (user_id, provider)
);

CREATE TRIGGER auth_providers_set_updated_at
BEFORE UPDATE ON auth_providers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One-time codes. Short-lived, so no soft delete; old rows are purged by the app.
CREATE TYPE otp_channel AS ENUM ('email', 'phone');
CREATE TYPE otp_purpose AS ENUM ('verify_email', 'verify_phone', 'login', 'reset_password');

CREATE TABLE otp_codes (
  id           UUID         PRIMARY KEY DEFAULT uuidv7(),
  channel      otp_channel  NOT NULL,
  target       VARCHAR(255) NOT NULL,  -- lowercase email or E.164 phone
  purpose      otp_purpose  NOT NULL,
  code_hash    TEXT         NOT NULL,  -- never the plain code
  expires_at   TIMESTAMPTZ  NOT NULL,
  attempts     INTEGER      NOT NULL DEFAULT 0,
  consumed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT otp_codes_attempts_non_negative CHECK (attempts >= 0)
);

CREATE INDEX otp_codes_lookup_idx ON otp_codes (channel, target, purpose, created_at DESC);

-- Refresh-token sessions. Revoked rather than soft deleted; expired rows are purged by the app.
CREATE TABLE refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT uuidv7(),
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,  -- SHA-256 of the cookie value
  user_agent  TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX refresh_tokens_active_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
