// SQL for seller_profiles.

const db = require("../config/db");

// The fields a seller may see. Converts database names to the API's camelCase.
function toPublicProfile(profile) {
  return {
    id: profile.id,
    storeName: profile.store_name,
    storeSlug: profile.store_slug,
    description: profile.description,
    logoUrl: profile.logo_url,
    bannerUrl: profile.banner_url,
    supportEmail: profile.support_email,
    supportPhone: profile.support_phone,
    businessType: profile.business_type,
    legalBusinessName: profile.legal_business_name,
    taxId: profile.tax_id,
    pickupAddressId: profile.pickup_address_id,
    verificationStatus: profile.verification_status,
    rejectionReason: profile.rejection_reason,
    commissionRate: profile.commission_rate,
    createdAt: profile.created_at,
  };
}

// The seller's view plus the fields that only admins need.
function toAdminProfile(profile) {
  return {
    ...toPublicProfile(profile),
    userId: profile.user_id,
    verifiedAt: profile.verified_at,
    verifiedBy: profile.verified_by,
  };
}

// verification_status isn't set here, so the database default of `pending` applies.
async function create(userId, fields) {
  const { rows } = await db.query(
    `INSERT INTO seller_profiles (
       user_id, store_name, store_slug, description, logo_url, banner_url, support_email,
       support_phone, business_type, legal_business_name, tax_id, pickup_address_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      userId,
      fields.storeName,
      fields.storeSlug,
      fields.description ?? null,
      fields.logoUrl ?? null,
      fields.bannerUrl ?? null,
      fields.supportEmail ?? null,
      fields.supportPhone ?? null,
      fields.businessType,
      fields.legalBusinessName,
      fields.taxId ?? null,
      fields.pickupAddressId ?? null,
    ]
  );
  return rows[0];
}

// A pickup address must belong to the seller creating the profile.
async function userOwnsAddress(userId, addressId) {
  const { rowCount } = await db.query(
    "SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [addressId, userId]
  );
  return rowCount === 1;
}

// Finds a live profile by id.
async function findById(id) {
  const { rows } = await db.query("SELECT * FROM seller_profiles WHERE id = $1 AND deleted_at IS NULL", [id]);
  return rows[0] ?? null;
}

const LIST_LIMIT = 100;

// Oldest first, so the longest-waiting sellers are reviewed first.
async function listByStatus(status) {
  const { rows } = await db.query(
    `SELECT * FROM seller_profiles
     WHERE verification_status = $1 AND deleted_at IS NULL
     ORDER BY created_at
     LIMIT $2`,
    [status, LIST_LIMIT]
  );
  return rows;
}

// Returns null if the profile doesn't exist or isn't pending or rejected. An approved seller
// can't be moved to rejected here; taking away an approval is what `suspended` is for.
async function decideVerification(id, { status, reason = null, adminId }) {
  const { rows } = await db.query(
    `UPDATE seller_profiles
     SET verification_status = $2, rejection_reason = $3, verified_at = NOW(), verified_by = $4
     WHERE id = $1 AND deleted_at IS NULL AND verification_status IN ('pending', 'rejected')
     RETURNING *`,
    [id, status, reason, adminId]
  );
  return rows[0] ?? null;
}

module.exports = {
  toPublicProfile,
  toAdminProfile,
  create,
  userOwnsAddress,
  findById,
  listByStatus,
  decideVerification,
};
