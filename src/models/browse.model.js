// SQL for what customers see. Every read goes through VISIBLE_FROM and VISIBLE_WHERE, so suspending a seller or
// hiding a category takes effect at once, without changing any products.

const db = require("../config/db");

// Active categories whose parents are all active too: an inactive category hides everything below it.
const VISIBLE_CATEGORIES = `visible_categories AS (
  SELECT id FROM categories WHERE parent_id IS NULL AND is_active AND deleted_at IS NULL
  UNION ALL
  SELECT c.id FROM categories c JOIN visible_categories v ON c.parent_id = v.id
  WHERE c.is_active AND c.deleted_at IS NULL
)`;

const VISIBLE_FROM = `
  FROM products p
  JOIN visible_categories vc ON vc.id = p.category_id
  JOIN categories c ON c.id = p.category_id
  JOIN seller_profiles s ON s.id = p.seller_id AND s.verification_status = 'approved' AND s.deleted_at IS NULL
  JOIN users u ON u.id = s.user_id AND u.status = 'active' AND u.deleted_at IS NULL`;

const VISIBLE_WHERE = `
  WHERE p.status = 'active' AND p.blocked_at IS NULL AND p.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM product_variants v WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active)
    AND EXISTS (SELECT 1 FROM product_images i WHERE i.product_id = p.id)`;

// Floored, so a discount is never shown as bigger than it is. Worked out in SQL, because NUMERIC is exact.
const DISCOUNT = "FLOOR((v.mrp - v.selling_price) * 100 / v.mrp)::int AS discount_percent";

// The cheapest variant and the main image, for product cards.
const CARD_JOINS = `
  CROSS JOIN LATERAL (
    SELECT v.selling_price, v.mrp, ${DISCOUNT} FROM product_variants v
    WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active
    ORDER BY v.selling_price, v.mrp DESC LIMIT 1
  ) cheapest
  CROSS JOIN LATERAL (
    SELECT i.url, i.alt_text FROM product_images i
    WHERE i.product_id = p.id ORDER BY i.is_primary DESC, i.sort_order, i.created_at LIMIT 1
  ) image`;

// Turns the filters into SQL. Each value goes in as a parameter, never into the SQL text.
function buildFilters({ q, categoryId, brandId, minPrice, maxPrice, inStock, option }) {
  const params = [];
  const add = (value) => `$${params.push(value)}`;
  const conditions = [];
  let categoryCte = "";

  if (q) {
    const text = add(q);
    // The first part finds whole words, including other forms ("mugs" finds "mug"); the second allows typos.
    conditions.push(`(p.search_vector @@ websearch_to_tsquery('english', ${text}) OR ${text} <% p.title)`);
  }
  if (categoryId) {
    // Products sit on the lowest categories, so choosing a parent means everything below it.
    categoryCte = `, chosen_categories AS (
      SELECT id FROM categories WHERE id = ${add(categoryId)}
      UNION ALL
      SELECT c.id FROM categories c JOIN chosen_categories cc ON c.parent_id = cc.id
    )`;
    conditions.push("p.category_id IN (SELECT id FROM chosen_categories)");
  }
  if (brandId) conditions.push(`p.brand_id = ANY(${add(brandId)}::uuid[])`);
  if (minPrice) conditions.push(`p.min_price >= ${add(minPrice)}::numeric`);
  if (maxPrice) conditions.push(`p.min_price <= ${add(maxPrice)}::numeric`);

  // One variant must match all of these: "size M, in stock" must not match a product whose only
  // size M is sold out. Values of one option are alternatives (M or L); different options must all match.
  const variantRules = [];
  if (inStock) variantRules.push("v.stock_quantity > 0");
  for (const [code, values] of Object.entries(option ?? {})) {
    const wanted = values.map((value) => JSON.stringify({ [code]: value }));
    variantRules.push(`v.options @> ANY(${add(wanted)}::jsonb[])`);
  }
  if (variantRules.length > 0) {
    conditions.push(`EXISTS (
      SELECT 1 FROM product_variants v
      WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active AND ${variantRules.join(" AND ")}
    )`);
  }

  return { params, add, categoryCte, where: conditions.map((condition) => `AND ${condition}`).join(" ") };
}

// The id comes last in each so products with equal values keep their order between pages.
function orderBy(sort, q, add) {
  if (sort === "price_asc") return "p.min_price ASC, p.id DESC";
  if (sort === "price_desc") return "p.min_price DESC, p.id DESC";
  if (sort === "relevance" && q) {
    const text = add(q);
    return `ts_rank(p.search_vector, websearch_to_tsquery('english', ${text})) + word_similarity(${text}, p.title) DESC, p.id DESC`;
  }
  return "p.created_at DESC, p.id DESC";
}

// How closely search text must match a word in a title. Postgres's default of 0.6 misses common
// typos such as "samsng"; 0.5 finds those without matching "shirt" to "skirt".
const TYPO_THRESHOLD = 0.5;

// One page of products, plus the total count. The price shown is the cheapest variant's.
async function list(filters) {
  const { sort, page, limit, q } = filters;

  const counted = buildFilters(filters);
  const countSql = `WITH RECURSIVE ${VISIBLE_CATEGORIES}${counted.categoryCte}
    SELECT COUNT(*)::int AS total ${VISIBLE_FROM} ${VISIBLE_WHERE} ${counted.where}`;

  // Picks the page first, so prices and images are only looked up for the products returned.
  const listed = buildFilters(filters);
  const listSql = `WITH RECURSIVE ${VISIBLE_CATEGORIES}${listed.categoryCte},
    page AS MATERIALIZED (
      SELECT p.id, ROW_NUMBER() OVER (ORDER BY ${orderBy(sort, q, listed.add)}) AS position
      ${VISIBLE_FROM} ${VISIBLE_WHERE} ${listed.where}
      ORDER BY position
      LIMIT ${listed.add(limit)} OFFSET ${listed.add((page - 1) * limit)}
    )
    SELECT p.id, p.slug, p.title,
           c.id AS category_id, c.name AS category_name, c.slug AS category_slug,
           b.id AS brand_id, b.name AS brand_name, b.slug AS brand_slug,
           s.store_name, s.store_slug,
           cheapest.selling_price, cheapest.mrp, cheapest.discount_percent,
           image.url AS image_url, image.alt_text AS image_alt_text,
           EXISTS (
             SELECT 1 FROM product_variants v
             WHERE v.product_id = p.id AND v.deleted_at IS NULL AND v.is_active AND v.stock_quantity > 0
           ) AS in_stock
    FROM page
    JOIN products p ON p.id = page.id
    JOIN categories c ON c.id = p.category_id
    JOIN seller_profiles s ON s.id = p.seller_id
    LEFT JOIN brands b ON b.id = p.brand_id
    ${CARD_JOINS}
    ORDER BY page.position`;

  // A search needs the threshold set on its connection, which SET LOCAL undoes when the transaction ends.
  if (q) {
    return db.transaction(async (client) => {
      await client.query(`SET LOCAL pg_trgm.word_similarity_threshold = ${TYPO_THRESHOLD}`);
      const items = await client.query(listSql, listed.params);
      const count = await client.query(countSql, counted.params);
      return { rows: items.rows, total: count.rows[0].total };
    });
  }
  const [items, count] = await Promise.all([db.query(listSql, listed.params), db.query(countSql, counted.params)]);
  return { rows: items.rows, total: count.rows[0].total };
}

async function findBySlug(slug) {
  const { rows } = await db.query(
    `WITH RECURSIVE ${VISIBLE_CATEGORIES}
     SELECT p.*,
            c.name AS category_name, c.slug AS category_slug,
            b.name AS brand_name, b.slug AS brand_slug, b.logo_url AS brand_logo_url,
            s.store_name, s.store_slug, s.logo_url AS store_logo_url,
            s.legal_business_name, s.support_email, s.support_phone
     ${VISIBLE_FROM}
     LEFT JOIN brands b ON b.id = p.brand_id
     ${VISIBLE_WHERE} AND p.slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

// Only variants on sale.
async function listVariants(productId) {
  const { rows } = await db.query(
    `SELECT v.id, v.options, v.option_labels, v.mrp, v.selling_price, v.net_quantity, v.stock_quantity, ${DISCOUNT}
     FROM product_variants v
     WHERE v.product_id = $1 AND v.deleted_at IS NULL AND v.is_active
     ORDER BY v.selling_price, v.created_at`,
    [productId]
  );
  return rows;
}

async function listImages(productId) {
  const { rows } = await db.query(
    `SELECT id, variant_id, url, alt_text, is_primary FROM product_images
     WHERE product_id = $1 ORDER BY is_primary DESC, sort_order, created_at`,
    [productId]
  );
  return rows;
}

// Names and labels for option codes. Includes deleted ones, because existing variants keep their
// codes after a value is deleted; a live row wins if a code was reused.
async function findOptionLabels(optionCodes) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (o.code, val.code)
            o.code AS option_code, o.name AS option_name,
            val.code AS value_code, val.label, val.color_hex, val.sort_order
     FROM variant_options o
     LEFT JOIN variant_option_values val ON val.option_id = o.id
     WHERE o.code = ANY($1::text[])
     ORDER BY o.code, val.code, o.deleted_at NULLS FIRST, val.deleted_at NULLS FIRST`,
    [optionCodes]
  );
  return rows;
}

module.exports = { list, findBySlug, listVariants, listImages, findOptionLabels };
