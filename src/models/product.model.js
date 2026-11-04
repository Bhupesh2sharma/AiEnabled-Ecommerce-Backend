// SQL for products. Sellers only reach their own: every lookup here includes the seller's id.

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const COLUMNS = {
  categoryId: "category_id",
  brandId: "brand_id",
  title: "title",
  description: "description",
  highlights: "highlights",
  specifications: "specifications",
  hsnCode: "hsn_code",
  genericName: "generic_name",
  countryOfOrigin: "country_of_origin",
  manufacturerName: "manufacturer_name",
  manufacturerAddress: "manufacturer_address",
  packerDetails: "packer_details",
  importerDetails: "importer_details",
  isReturnable: "is_returnable",
  returnWindowDays: "return_window_days",
  warrantySummary: "warranty_summary",
};

function toSellerProduct(product) {
  return {
    id: product.id,
    categoryId: product.category_id,
    brandId: product.brand_id,
    title: product.title,
    slug: product.slug,
    description: product.description,
    highlights: product.highlights,
    specifications: product.specifications,
    hsnCode: product.hsn_code,
    genericName: product.generic_name,
    countryOfOrigin: product.country_of_origin,
    manufacturerName: product.manufacturer_name,
    manufacturerAddress: product.manufacturer_address,
    packerDetails: product.packer_details,
    importerDetails: product.importer_details,
    isReturnable: product.is_returnable,
    returnWindowDays: product.return_window_days,
    warrantySummary: product.warranty_summary,
    status: product.status,
    minPrice: product.min_price,
    isBlocked: product.blocked_at !== null,
    blockedReason: product.blocked_reason,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
  };
}

// The pg library would turn specifications into text the wrong way, so it's sent as JSON explicitly.
function toParams(fields) {
  return fields.specifications === undefined
    ? fields
    : { ...fields, specifications: JSON.stringify(fields.specifications) };
}

async function create(sellerId, slug, fields, client) {
  const { highlights, specifications } = toParams(fields);
  const { rows } = await client.query(
    `INSERT INTO products (
       seller_id, slug, category_id, brand_id, title, description, highlights, specifications, hsn_code,
       generic_name, country_of_origin, manufacturer_name, manufacturer_address, packer_details,
       importer_details, is_returnable, return_window_days, warranty_summary
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, COALESCE($7, '{}'::text[]), COALESCE($8::jsonb, '{}'::jsonb), $9,
       $10, $11, $12, $13, $14, $15, COALESCE($16, TRUE), COALESCE($17, 7), $18
     )
     RETURNING *`,
    [
      sellerId,
      slug,
      fields.categoryId,
      fields.brandId ?? null,
      fields.title,
      fields.description ?? null,
      highlights ?? null,
      specifications ?? null,
      fields.hsnCode ?? null,
      fields.genericName ?? null,
      fields.countryOfOrigin ?? null,
      fields.manufacturerName ?? null,
      fields.manufacturerAddress ?? null,
      fields.packerDetails ?? null,
      fields.importerDetails ?? null,
      fields.isReturnable ?? null,
      fields.returnWindowDays ?? null,
      fields.warrantySummary ?? null,
    ]
  );
  return rows[0];
}

async function findOwned(id, sellerId, client = db) {
  const { rows } = await client.query(
    "SELECT * FROM products WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL",
    [id, sellerId]
  );
  return rows[0] ?? null;
}

// Same as findOwned, but holds the product until the transaction ends. Every change to a product or
// its variants takes this first, so min_price and the "last variant" check can't go wrong in parallel.
async function lockOwned(id, sellerId, client) {
  const { rows } = await client.query(
    "SELECT * FROM products WHERE id = $1 AND seller_id = $2 AND deleted_at IS NULL FOR UPDATE",
    [id, sellerId]
  );
  return rows[0] ?? null;
}

async function listOwned(sellerId, { status, page, limit }) {
  const where = "p.seller_id = $1 AND p.deleted_at IS NULL AND ($2::product_status IS NULL OR p.status = $2)";
  const params = [sellerId, status ?? null];
  const [items, count] = await Promise.all([
    db.query(
      `SELECT p.*,
              (SELECT COUNT(*)::int FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL) AS variant_count
       FROM products p WHERE ${where}
       ORDER BY p.created_at DESC
       LIMIT $3 OFFSET $4`,
      [...params, limit, (page - 1) * limit]
    ),
    db.query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`, params),
  ]);
  return { rows: items.rows, total: count.rows[0].total };
}

async function update(id, fields, client) {
  const { assignments, values } = buildAssignments(toParams(fields), COLUMNS);
  const { rows } = await client.query(`UPDATE products SET ${assignments} WHERE id = $1 RETURNING *`, [id, ...values]);
  return rows[0];
}

// Sets min_price to the lowest price customers could pay, or NULL if no variant is on sale.
async function refreshMinPrice(id, client) {
  await client.query(
    `UPDATE products
     SET min_price = (
       SELECT MIN(selling_price) FROM product_variants
       WHERE product_id = $1 AND deleted_at IS NULL AND is_active
     )
     WHERE id = $1`,
    [id]
  );
}

// Also deletes its variants, so their SKUs can be reused.
async function softDelete(id, client) {
  await client.query("UPDATE product_variants SET deleted_at = NOW() WHERE product_id = $1 AND deleted_at IS NULL", [id]);
  await client.query("UPDATE products SET deleted_at = NOW() WHERE id = $1", [id]);
}

module.exports = { toSellerProduct, create, findOwned, lockOwned, listOwned, update, refreshMinPrice, softDelete };
