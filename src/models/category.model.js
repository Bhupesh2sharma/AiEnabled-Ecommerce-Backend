// SQL for categories and for which variant options each category uses.

const db = require("../config/db");
const buildAssignments = require("../utils/sqlUpdate");

const COLUMNS = {
  name: "name",
  slug: "slug",
  parentId: "parent_id",
  description: "description",
  imageUrl: "image_url",
  defaultHsnCode: "default_hsn_code",
  sortOrder: "sort_order",
  isActive: "is_active",
};

function toPublicCategory(category) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    imageUrl: category.image_url,
    defaultHsnCode: category.default_hsn_code,
  };
}

function toAdminCategory(category) {
  return {
    ...toPublicCategory(category),
    parentId: category.parent_id,
    sortOrder: category.sort_order,
    isActive: category.is_active,
    createdAt: category.created_at,
    updatedAt: category.updated_at,
  };
}

// Allows only one change to the tree at a time, so the depth and loop checks can't be
// bypassed by two admins moving categories at the same moment. Released when the transaction ends.
async function lockTree(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('categories_tree', 0))");
}

async function listAll() {
  const { rows } = await db.query("SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY sort_order, name");
  return rows;
}

async function findById(id, client = db) {
  const { rows } = await client.query("SELECT * FROM categories WHERE id = $1 AND deleted_at IS NULL", [id]);
  return rows[0] ?? null;
}

// How deep a category sits: a top-level category is 1.
async function getDepth(id, client = db) {
  const { rows } = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id FROM categories WHERE id = $1
       UNION ALL
       SELECT c.id, c.parent_id FROM categories c JOIN chain ON c.id = chain.parent_id
     )
     SELECT COUNT(*)::int AS depth FROM chain`,
    [id]
  );
  return rows[0].depth;
}

// A category and everything below it, with `level` 1 for the category itself.
async function getSubtree(id, client = db) {
  const { rows } = await client.query(
    `WITH RECURSIVE tree AS (
       SELECT id, 1 AS level FROM categories WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id, tree.level + 1 FROM categories c JOIN tree ON c.parent_id = tree.id WHERE c.deleted_at IS NULL
     )
     SELECT id, level FROM tree`,
    [id]
  );
  return rows;
}

async function create(fields, client = db) {
  const { rows } = await client.query(
    `INSERT INTO categories (name, slug, parent_id, description, image_url, default_hsn_code, sort_order, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 0), COALESCE($8, TRUE))
     RETURNING *`,
    [
      fields.name,
      fields.slug,
      fields.parentId ?? null,
      fields.description ?? null,
      fields.imageUrl ?? null,
      fields.defaultHsnCode ?? null,
      fields.sortOrder ?? null,
      fields.isActive ?? null,
    ]
  );
  return rows[0];
}

async function update(id, fields, client = db) {
  const { assignments, values } = buildAssignments(fields, COLUMNS);
  const { rows } = await client.query(
    `UPDATE categories SET ${assignments} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
    [id, ...values]
  );
  return rows[0] ?? null;
}

async function softDelete(id, client = db) {
  await client.query("UPDATE categories SET deleted_at = NOW() WHERE id = $1", [id]);
}

async function hasChildren(id, client = db) {
  const { rowCount } = await client.query(
    "SELECT 1 FROM categories WHERE parent_id = $1 AND deleted_at IS NULL LIMIT 1",
    [id]
  );
  return rowCount === 1;
}

async function hasProducts(id, client = db) {
  const { rowCount } = await client.query(
    "SELECT 1 FROM products WHERE category_id = $1 AND deleted_at IS NULL LIMIT 1",
    [id]
  );
  return rowCount === 1;
}

// Customers can see a category only if it and every parent above it are active.
async function isVisible(id) {
  const { rows } = await db.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, is_active FROM categories WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_id, c.is_active FROM categories c JOIN chain ON c.id = chain.parent_id
       WHERE c.deleted_at IS NULL
     )
     SELECT COUNT(*) > 0 AND BOOL_AND(is_active) AS visible FROM chain`,
    [id]
  );
  return rows[0].visible;
}

// The options a category uses: its own plus its parents'. If both set the same option,
// the setting closest to the category wins. Deleted options and values are left out.
async function getEffectiveOptions(id, client = db) {
  const { rows } = await client.query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id, 0 AS distance FROM categories WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT c.id, c.parent_id, chain.distance + 1 FROM categories c JOIN chain ON c.id = chain.parent_id
       WHERE c.deleted_at IS NULL
     ),
     picked AS (
       SELECT DISTINCT ON (cvo.option_id) cvo.option_id, cvo.is_required, cvo.sort_order, chain.distance
       FROM chain JOIN category_variant_options cvo ON cvo.category_id = chain.id
       ORDER BY cvo.option_id, chain.distance
     )
     SELECT o.id, o.name, o.code, o.allow_custom_values, p.is_required, p.sort_order, p.distance,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT('id', v.id, 'label', v.label, 'code', v.code, 'colorHex', v.color_hex, 'sortOrder', v.sort_order)
                ORDER BY v.sort_order, v.label
              ) FILTER (WHERE v.id IS NOT NULL),
              '[]'
            ) AS values
     FROM picked p
     JOIN variant_options o ON o.id = p.option_id AND o.deleted_at IS NULL
     LEFT JOIN variant_option_values v ON v.option_id = o.id AND v.deleted_at IS NULL
     GROUP BY o.id, p.is_required, p.sort_order, p.distance
     ORDER BY p.distance DESC, p.sort_order, o.name`,
    [id]
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    allowCustomValues: row.allow_custom_values,
    isRequired: row.is_required,
    sortOrder: row.sort_order,
    inherited: row.distance > 0,
    values: row.values,
  }));
}

// Replaces the options set directly on a category. Inherited ones are unaffected.
async function setOptions(id, options, client) {
  await client.query("DELETE FROM category_variant_options WHERE category_id = $1", [id]);
  for (const { optionId, isRequired, sortOrder } of options) {
    await client.query(
      "INSERT INTO category_variant_options (category_id, option_id, is_required, sort_order) VALUES ($1, $2, $3, $4)",
      [id, optionId, isRequired, sortOrder]
    );
  }
}

module.exports = {
  toPublicCategory,
  toAdminCategory,
  lockTree,
  listAll,
  findById,
  getDepth,
  getSubtree,
  create,
  update,
  softDelete,
  hasChildren,
  hasProducts,
  isVisible,
  getEffectiveOptions,
  setOptions,
};
