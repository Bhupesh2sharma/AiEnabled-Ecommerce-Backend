// Adds sample categories and variant options, so a development database has something to work with.
//
//   npm run seed:catalog
//
// Safe to run again: anything that already exists is left exactly as it is, including admins' edits,
// so only what's missing is added. Something deleted counts as missing and comes back.
// Refuses to run in production, where admins create the real categories.
//
// No food, medicines or similar: they need licences and expiry tracking the catalog doesn't have yet.

const slugify = require("../src/utils/slug");

const OPTIONS = [
  { name: "Size", code: "size", values: ["XS", "S", "M", "L", "XL", "XXL"] },
  { name: "Shoe Size (UK)", code: "shoe-size", values: ["6", "7", "8", "9", "10", "11"] },
  { name: "RAM", code: "ram", values: ["4 GB", "6 GB", "8 GB", "12 GB", "16 GB", "32 GB"] },
  { name: "Storage", code: "storage", values: ["64 GB", "128 GB", "256 GB", "512 GB", "1 TB"] },
  {
    name: "Colour",
    code: "colour",
    allowCustomValues: true,
    values: [
      ["Black", "#000000"],
      ["White", "#FFFFFF"],
      ["Grey", "#808080"],
      ["Red", "#FF0000"],
      ["Blue", "#0000FF"],
      ["Green", "#008000"],
      ["Yellow", "#FFFF00"],
      ["Pink", "#FFC0CB"],
    ],
  },
];

// `options` are "code" (required) or "code?" (optional), and apply to everything below the category too.
// `hsn` is only a suggestion sellers can change; have a CA confirm these before relying on them.
const CATEGORIES = [
  {
    name: "Clothing",
    options: ["size", "colour"],
    children: [
      {
        name: "Men's Clothing",
        children: [{ name: "Men's T-Shirts", hsn: "6109" }, { name: "Men's Shirts" }, { name: "Men's Jeans" }],
      },
      {
        name: "Women's Clothing",
        children: [{ name: "Women's T-Shirts", hsn: "6109" }, { name: "Kurtas" }, { name: "Sarees", options: ["size?"] }],
      },
    ],
  },
  {
    name: "Footwear",
    options: ["shoe-size", "colour"],
    children: [{ name: "Men's Footwear" }, { name: "Women's Footwear" }],
  },
  {
    name: "Electronics",
    children: [
      {
        name: "Mobiles",
        options: ["ram", "storage", "colour"],
        children: [{ name: "Smartphones", hsn: "8517" }],
      },
      {
        name: "Computers",
        options: ["ram", "storage", "colour?"],
        children: [{ name: "Laptops", hsn: "8471" }],
      },
    ],
  },
  {
    name: "Home & Kitchen",
    options: ["colour?"],
    children: [{ name: "Drinkware" }, { name: "Bed Linen" }],
  },
  {
    name: "Books",
    children: [
      { name: "Fiction", hsn: "4901" },
      { name: "Non-Fiction", hsn: "4901" },
    ],
  },
];

// Values use slugify(label) as their code, because that's how a seller's typed value is matched.
async function seedOptions(client, added) {
  const ids = new Map();
  for (const option of OPTIONS) {
    const { rows } = await client.query("SELECT id FROM variant_options WHERE code = $1 AND deleted_at IS NULL", [option.code]);
    if (rows[0]) {
      ids.set(option.code, rows[0].id);
      continue;
    }
    const created = await client.query(
      "INSERT INTO variant_options (name, code, allow_custom_values) VALUES ($1, $2, $3) RETURNING id",
      [option.name, option.code, option.allowCustomValues ?? false]
    );
    const optionId = created.rows[0].id;
    ids.set(option.code, optionId);
    added.options += 1;

    for (const [index, value] of option.values.entries()) {
      const [label, colorHex] = Array.isArray(value) ? value : [value, null];
      await client.query(
        "INSERT INTO variant_option_values (option_id, label, code, color_hex, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [optionId, label, slugify(label), colorHex, index]
      );
      added.values += 1;
    }
  }
  return ids;
}

async function seedCategories(client, CategoryModel, categories, parentId, optionIds, added, warnings) {
  for (const [index, category] of categories.entries()) {
    const slug = slugify(category.name);
    const { rows } = await client.query(
      `SELECT id FROM categories WHERE deleted_at IS NULL
       AND (slug = $1 OR (parent_id IS NOT DISTINCT FROM $2::uuid AND LOWER(name) = LOWER($3)))`,
      [slug, parentId, category.name]
    );
    let id = rows[0]?.id;

    if (!id) {
      // A category with products can't have sub-categories, so this part of the tree is skipped.
      if (parentId && (await CategoryModel.hasProducts(parentId, client))) {
        warnings.push(`Skipped "${category.name}": its parent category has products`);
        continue;
      }
      const created = await CategoryModel.create(
        { name: category.name, slug, parentId, defaultHsnCode: category.hsn, sortOrder: index },
        client
      );
      id = created.id;
      added.categories += 1;

      for (const [position, entry] of (category.options ?? []).entries()) {
        const code = entry.replace("?", "");
        await client.query(
          "INSERT INTO category_variant_options (category_id, option_id, is_required, sort_order) VALUES ($1, $2, $3, $4)",
          [id, optionIds.get(code), !entry.endsWith("?"), position]
        );
        added.assignments += 1;
      }
    }

    await seedCategories(client, CategoryModel, category.children ?? [], id, optionIds, added, warnings);
  }
}

// All or nothing, under the tree lock, so it can't clash with an admin changing categories.
async function seedCatalog() {
  const db = require("../src/config/db");
  const CategoryModel = require("../src/models/category.model");

  const added = { options: 0, values: 0, categories: 0, assignments: 0 };
  const warnings = [];
  await db.transaction(async (client) => {
    await CategoryModel.lockTree(client);
    const optionIds = await seedOptions(client, added);
    await seedCategories(client, CategoryModel, CATEGORIES, null, optionIds, added, warnings);
  });
  return { added, warnings };
}

async function main() {
  // Checked before anything from src/ loads, because loading it needs production settings.
  if (process.env.NODE_ENV === "production") {
    throw new Error("Sample data isn't for production. Admins create the real categories through the API.");
  }
  const { pool } = require("../src/config/db");
  try {
    const { added, warnings } = await seedCatalog();
    console.log(
      `Added ${added.categories} categories, ${added.options} options, ${added.values} option values, ` +
        `${added.assignments} category options`
    );
    for (const warning of warnings) console.warn(warning);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { seedCatalog };
