// SQL for brands.

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const COLUMNS = { name: "name", slug: "slug", logoUrl: "logo_url", isActive: "is_active" };

function toPublicBrand(brand) {
  return { id: brand.id, name: brand.name, slug: brand.slug, logoUrl: brand.logo_url };
}

function toAdminBrand(brand) {
  return { ...toPublicBrand(brand), isActive: brand.is_active, createdAt: brand.created_at, updatedAt: brand.updated_at };
}

// One page of brands by name, optionally only those starting with `q`, plus the total count.
async function list({ activeOnly, q, page, limit }) {
  const where = `deleted_at IS NULL AND ($1::boolean IS FALSE OR is_active) AND ($2::text IS NULL OR STARTS_WITH(LOWER(name), LOWER($2)))`;
  const params = [activeOnly, q ?? null];
  const [items, count] = await Promise.all([
    db.query(`SELECT * FROM brands WHERE ${where} ORDER BY LOWER(name) LIMIT $3 OFFSET $4`, [
      ...params,
      limit,
      (page - 1) * limit,
    ]),
    db.query(`SELECT COUNT(*)::int AS total FROM brands WHERE ${where}`, params),
  ]);
  return { rows: items.rows, total: count.rows[0].total };
}

async function create({ name, slug, logoUrl, isActive }) {
  const { rows } = await db.query(
    "INSERT INTO brands (name, slug, logo_url, is_active) VALUES ($1, $2, $3, COALESCE($4, TRUE)) RETURNING *",
    [name, slug, logoUrl ?? null, isActive ?? null]
  );
  return rows[0];
}

// Returns null if the brand doesn't exist.
async function update(id, fields) {
  const { assignments, values } = buildAssignments(fields, COLUMNS);
  const { rows } = await db.query(
    `UPDATE brands SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, ...values]
  );
  return rows[0] ?? null;
}

// Refuses in one statement if the brand has live products, so a product added at the same moment can't slip through.
// Returns "deleted", "in_use" or "not_found".
async function softDelete(id) {
  const { rows } = await db.query(
    `WITH target AS (SELECT id FROM brands WHERE id = $1 AND deleted_at IS NULL FOR UPDATE),
     used AS (SELECT EXISTS (SELECT 1 FROM products WHERE brand_id = $1 AND deleted_at IS NULL) AS in_use),
     done AS (
       UPDATE brands SET deleted_at = NOW()
       WHERE id IN (SELECT id FROM target) AND NOT (SELECT in_use FROM used)
       RETURNING id
     )
     SELECT (SELECT COUNT(*) FROM target)::int AS found, (SELECT in_use FROM used) AS in_use, (SELECT COUNT(*) FROM done)::int AS removed`,
    [id]
  );
  const { found, in_use: inUse, removed } = rows[0];
  if (!found) return "not_found";
  return removed ? "deleted" : inUse ? "in_use" : "not_found";
}

module.exports = { toPublicBrand, toAdminBrand, list, create, update, softDelete };
