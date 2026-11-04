# Database Schema

PostgreSQL 18 (Docker container `ecommerce_db`, database `ecom_db`).
Source of truth is the SQL in `src/db/migrations/`. This document explains it:
what each table is for, how tables are grouped, and how they relate.

> Keep this file in sync with migrations. Every migration that adds or changes
> a table must update this document in the same change.

## Table groups\


| Group | Tables | Purpose |
|---|---|---|
| Identity & Access | `users`, `auth_providers`, `otp_codes`, `refresh_tokens` | Accounts for every role (customer, seller, admin), login and consent, linked external identities, one-time codes and sessions |
| Customer | `addresses` | Saved shipping/billing addresses (also used for seller pickup) |
| Seller | `seller_profiles` | Storefront, business/KYC, payout and approval details for sellers |
| System | `schema_migrations` | Tracks which migration files have been applied (managed by `scripts/migrate.js`) |

## Relationships

```mermaid
erDiagram
    users ||--o{ auth_providers : "links"
    users ||--o{ refresh_tokens : "has sessions"
    users ||--o{ addresses : "owns"
    users ||--o| seller_profiles : "has (role = seller)"
    users ||--o{ seller_profiles : "verifies (admin, verified_by)"
    addresses ||--o{ seller_profiles : "pickup address"
```

| From | To | Type | FK column | On delete |
|---|---|---|---|---|
| `auth_providers` | `users` | many-to-one | `auth_providers.user_id` | CASCADE |
| `refresh_tokens` | `users` | many-to-one | `refresh_tokens.user_id` | CASCADE |
| `addresses` | `users` | many-to-one | `addresses.user_id` | CASCADE |
| `seller_profiles` | `users` | one-to-one | `seller_profiles.user_id` (UNIQUE) | CASCADE |
| `seller_profiles` | `users` (admin) | many-to-one | `seller_profiles.verified_by` | SET NULL |
| `seller_profiles` | `addresses` | many-to-one | `seller_profiles.pickup_address_id` | SET NULL |

## Conventions (apply to every table)

- **Primary key:** `id UUID PRIMARY KEY DEFAULT uuidv7()`. Time-ordered, safe to expose in URLs.
- **Timestamps:** `created_at`, `updated_at` as `TIMESTAMPTZ NOT NULL DEFAULT NOW()`.
  Attach the shared `set_updated_at()` trigger so `updated_at` changes on every UPDATE.
- **Soft delete:** `deleted_at TIMESTAMPTZ` (NULL = live). Queries must filter `deleted_at IS NULL`.
  Unique indexes are partial (`WHERE deleted_at IS NULL`) so deleted rows don't block reuse.
- **Fixed value sets:** Postgres `ENUM` types (e.g. `user_role`).
- **Phone numbers:** E.164 format (`+919876543210`), enforced by CHECK constraint.
- **"Yes/no + when" flags:** a nullable timestamp (e.g. `email_verified_at`) rather than a boolean.
- **Money:** `NUMERIC`, never `FLOAT`.
- **Naming:** plural snake_case tables, `<table>_<column>_idx` indexes, `<table>_<rule>` constraints.

---

## Identity & Access

### `users`
Migrations: `20261101000100_create_users.sql`, `20261104120742_auth_schema.sql`

One row per account. Role decides what the account can do; role-specific data lives in
separate tables (e.g. `seller_profiles`).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK, `uuidv7()` |
| `name` | VARCHAR(100) | required |
| `email` | VARCHAR(255) | optional (phone-only accounts), unique case-insensitive among non-deleted users. CHECK: `email` or `phone` must be set |
| `phone` | VARCHAR(20) | optional, E.164, unique among non-deleted users |
| `avatar_url` | TEXT | |
| `password_hash` | TEXT | bcrypt hash, never plain text. NULL for Google and phone users |
| `role` | `user_role` | `customer` (default), `seller`, `admin` |
| `status` | `user_status` | `active` (default), `inactive`, `suspended` |
| `email_verified_at` | TIMESTAMPTZ | NULL = not verified |
| `phone_verified_at` | TIMESTAMPTZ | NULL = not verified |
| `terms_accepted_at` | TIMESTAMPTZ | required, cannot register without it |
| `terms_version` | VARCHAR(20) | which version of the terms was accepted |
| `marketing_opt_in` | BOOLEAN | default false, separate from terms |
| `last_login_at` | TIMESTAMPTZ | |
| `failed_login_count` | INTEGER | default 0, for lockout |
| `locked_until` | TIMESTAMPTZ | temporary lock after repeated failed logins |
| `created_at` / `updated_at` / `deleted_at` | TIMESTAMPTZ | standard |

**Rules (enforced in application code, not the DB)**
- Emails are stored lowercase.
- `users.phone` is only ever set after the number has been proven with an OTP.
- Signup always needs `termsAccepted: true`; public signup can only create `customer` or `seller`.
- Admins cannot log in with a phone OTP or Google.
- Five failed password logins set `locked_until` 15 minutes ahead.
- Taking over an unverified email (Google link or email OTP login) clears `password_hash` and revokes
  all sessions, so whoever registered that email without proving it loses access.

**Referenced by:** `auth_providers.user_id`, `refresh_tokens.user_id`, `addresses.user_id`, `seller_profiles.user_id`, `seller_profiles.verified_by`.

### `auth_providers`
Migration: `20261104120742_auth_schema.sql`

Links a user to an external identity (Google today).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | FK → `users.id`, CASCADE. One identity per provider per user |
| `provider` | `auth_provider` | `google` |
| `provider_user_id` | VARCHAR(255) | provider's stable id (Google `sub`), unique per provider |
| `created_at` / `updated_at` | TIMESTAMPTZ | standard; no soft delete |

### `otp_codes`
Migration: `20261104120742_auth_schema.sql`

One-time codes for email and phone. Not linked to `users`: a phone signup has a code before it has a user.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `channel` | `otp_channel` | `email`, `phone` |
| `target` | VARCHAR(255) | lowercase email or E.164 phone |
| `purpose` | `otp_purpose` | `verify_email`, `verify_phone`, `login`, `reset_password` |
| `code_hash` | TEXT | HMAC-SHA-256 of the code, bound to target and purpose |
| `expires_at` | TIMESTAMPTZ | 5 minutes after creation |
| `attempts` | INTEGER | at most 5 |
| `consumed_at` | TIMESTAMPTZ | set when used, or when replaced by a newer code |
| `created_at` | TIMESTAMPTZ | no `updated_at` or soft delete; rows older than a day are purged on the next send |

**Rules (enforced in application code, not the DB)**
- Per target and purpose: one send every 60 seconds, at most 5 per hour. Only the newest code works.

### `refresh_tokens`
Migration: `20261104120742_auth_schema.sql`

One row per login session. Rotated on every refresh.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | FK → `users.id`, CASCADE |
| `token_hash` | TEXT | SHA-256 of the cookie value, unique |
| `user_agent` | TEXT | device the session started on |
| `expires_at` | TIMESTAMPTZ | 7 days after creation (`REFRESH_TOKEN_EXPIRES_DAYS`) |
| `revoked_at` | TIMESTAMPTZ | set on rotation, logout and password reset |
| `created_at` | TIMESTAMPTZ | no `updated_at` or soft delete; expired rows are purged on the next login |

---

## Customer

### `addresses`
Migration: `20261101045705_create_addresses.sql`

A user's address book. Used for customer shipping/billing and seller pickup.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | FK → `users.id`, CASCADE |
| `label` | VARCHAR(50) | e.g. Home, Work, Warehouse |
| `full_name` / `phone` | VARCHAR | recipient; may differ from account holder. Phone required, E.164 |
| `address_line1` | VARCHAR(255) | required |
| `address_line2`, `landmark` | VARCHAR(255) | optional |
| `city`, `state`, `postal_code` | VARCHAR | required |
| `country_code` | CHAR(2) | ISO 3166-1 alpha-2 (`IN`, `US`), required |
| `is_default_shipping` | BOOLEAN | at most one per user (partial unique index) |
| `is_default_billing` | BOOLEAN | at most one per user (partial unique index) |
| `created_at` / `updated_at` / `deleted_at` | TIMESTAMPTZ | standard |

**Rules**
- Orders must **copy** the address into the order when placed, not just reference `addresses.id`,
  so editing/deleting an address never changes a past order.
- Switching the default: unset the old default before setting the new one (same transaction),
  otherwise the unique index rejects it.

**Referenced by:** `seller_profiles.pickup_address_id`.

---

## Seller

### `seller_profiles`
Migration: `20261101045706_create_seller_profiles.sql`

One profile per seller account (`users.role = 'seller'`).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID | PK |
| `user_id` | UUID | FK → `users.id`, UNIQUE (one profile per user), CASCADE |
| `store_name` | VARCHAR(150) | public store name |
| `store_slug` | VARCHAR(160) | lowercase-hyphenated, unique among non-deleted; used in URLs |
| `description`, `logo_url`, `banner_url` | TEXT | storefront |
| `support_email` / `support_phone` | VARCHAR | customer-facing contact; phone E.164 |
| `business_type` | `seller_business_type` | `individual` (default), `company` |
| `legal_business_name` | VARCHAR(200) | required |
| `tax_id` | VARCHAR(50) | optional GSTIN, uppercase, format checked by the app |
| `pickup_address_id` | UUID | FK → `addresses.id`, SET NULL |
| `payout_account_id` | VARCHAR(100) | payment-provider account reference (Razorpay Route / Stripe Connect); never raw bank details |
| `verification_status` | `seller_verification_status` | `pending` (default), `approved`, `rejected`, `suspended` |
| `verified_at` | TIMESTAMPTZ | when an admin reviewed |
| `verified_by` | UUID | FK → `users.id` (the admin), SET NULL |
| `rejection_reason` | TEXT | required when status is `rejected` |
| `commission_rate` | NUMERIC(5,2) | platform fee %, default 10.00, 0–100 |
| `created_at` / `updated_at` / `deleted_at` | TIMESTAMPTZ | standard |

**Rules (enforced in application code, not the DB)**
- Only create a profile for a user whose `role = 'seller'` and whose email and phone are both verified.
- `verified_by` must be a user with `role = 'admin'`.
- `pickup_address_id` must belong to the same seller (`addresses.user_id = seller_profiles.user_id`).
- Only `approved` sellers may list products or receive orders.
- Editing a `rejected` profile, or the legal details of an `approved` one, returns it to `pending` and clears
  `rejection_reason`, `verified_at` and `verified_by`. `suspended` profiles can't be edited.
- Admins review `pending` or `rejected` profiles. An `approved` profile can't be rejected
  (`suspended` is for removing an approval, and has no endpoint yet).

---

## System

### `schema_migrations`
Created and managed by `scripts/migrate.js`. Do not edit by hand.

| Column | Type | Notes |
|---|---|---|
| `name` | TEXT | PK, migration filename |
| `applied_at` | TIMESTAMPTZ | when it was applied |
