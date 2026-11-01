-- Seller profiles: store and business details for users with role = 'seller'.
-- One profile per seller. The app must only create a profile for a seller account.

CREATE TYPE seller_business_type AS ENUM ('individual', 'company');
CREATE TYPE seller_verification_status AS ENUM ('pending', 'approved', 'rejected', 'suspended');

CREATE TABLE seller_profiles (
  id                    UUID                       PRIMARY KEY DEFAULT uuidv7(),
  user_id               UUID                       NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,

  -- Storefront (shown to customers)
  store_name            VARCHAR(150)               NOT NULL,
  store_slug            VARCHAR(160)               NOT NULL,  -- URL-friendly, e.g. /store/rk-electronics
  description           TEXT,
  logo_url              TEXT,
  banner_url            TEXT,
  support_email         VARCHAR(255),
  support_phone         VARCHAR(20),

  -- Business / legal (KYC)
  business_type         seller_business_type       NOT NULL DEFAULT 'individual',
  legal_business_name   VARCHAR(200)               NOT NULL,
  tax_id                VARCHAR(50),                          -- e.g. GSTIN in India, EIN/VAT elsewhere
  pickup_address_id     UUID                       REFERENCES addresses (id) ON DELETE SET NULL,

  -- Payouts: store the payment provider's account reference
  -- (e.g. Razorpay Route / Stripe Connect), never raw bank account numbers.
  payout_account_id     VARCHAR(100),

  -- Marketplace approval
  verification_status   seller_verification_status NOT NULL DEFAULT 'pending',
  verified_at           TIMESTAMPTZ,
  verified_by           UUID                       REFERENCES users (id) ON DELETE SET NULL,  -- admin who reviewed
  rejection_reason      TEXT,

  commission_rate       NUMERIC(5, 2)              NOT NULL DEFAULT 10.00,  -- platform fee, percent of sale

  created_at            TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ                NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ,

  CONSTRAINT seller_profiles_store_slug_format CHECK (store_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT seller_profiles_support_phone_format CHECK (support_phone IS NULL OR support_phone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT seller_profiles_commission_rate_range CHECK (commission_rate BETWEEN 0 AND 100),
  CONSTRAINT seller_profiles_rejection_reason_required
    CHECK (verification_status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE UNIQUE INDEX seller_profiles_store_slug_unique
  ON seller_profiles (store_slug) WHERE deleted_at IS NULL;
CREATE INDEX seller_profiles_verification_status_idx
  ON seller_profiles (verification_status) WHERE deleted_at IS NULL;

CREATE TRIGGER seller_profiles_set_updated_at
BEFORE UPDATE ON seller_profiles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
