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
    "SELECT 1 FROM addresses WHERE id = $1 AND user_id = $2",
    [addressId, userId]
  );
  return rowCount === 1;
}

// Finds a seller's own profile.
async function findByUserId(userId) {
  const { rows } = await db.query("SELECT * FROM seller_profiles WHERE user_id = $1 AND deleted_at IS NULL", [
    userId,
  ]);
  return rows[0] ?? null;
}

// Same as findByUserId, but locks the row until the transaction ends.
async function findByUserIdForUpdate(userId, client) {
  const { rows } = await client.query(
    "SELECT * FROM seller_profiles WHERE user_id = $1 AND deleted_at IS NULL FOR UPDATE",
    [userId]
  );
  return rows[0] ?? null;
}

// Blocks a profile edit until the transaction ends, while other readers can continue.
async function findByUserIdForShare(userId, client) {
  const { rows } = await client.query(
    "SELECT * FROM seller_profiles WHERE user_id = $1 AND deleted_at IS NULL FOR SHARE",
    [userId]
  );
  return rows[0] ?? null;
}

// The only columns a seller can change. Column names come from this list, never from the request.
const EDITABLE_COLUMNS = {
  storeName: "store_name",
  storeSlug: "store_slug",
  description: "description",
  logoUrl: "logo_url",
  bannerUrl: "banner_url",
  supportEmail: "support_email",
  supportPhone: "support_phone",
  businessType: "business_type",
  legalBusinessName: "legal_business_name",
  taxId: "tax_id",
  pickupAddressId: "pickup_address_id",
};

// Updates the fields that were sent. resetReview returns the profile to `pending` and clears the last decision.
async function update(id, fields, { resetReview = false } = {}, client = db) {
  const assignments = [];
  const values = [id];
  for (const [field, column] of Object.entries(EDITABLE_COLUMNS)) {
    if (fields[field] !== undefined) {
      values.push(fields[field]);
      assignments.push(`${column} = $${values.length}`);
    }
  }
  if (resetReview) {
    assignments.push(
      "verification_status = 'pending'",
      "rejection_reason = NULL",
      "verified_at = NULL",
      "verified_by = NULL"
    );
  }

  const { rows } = await client.query(
    `UPDATE seller_profiles SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
    values
  );
  return rows[0];
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
  findByUserId,
  findByUserIdForUpdate,
  findByUserIdForShare,
  update,
  listByStatus,
  decideVerification,
};
