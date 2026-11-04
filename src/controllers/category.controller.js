// Categories: the public tree, and the admin endpoints that manage it.

const db = require("../config/db");
const CategoryModel = require("../models/category.model");
const VariantOptionModel = require("../models/variantOption.model");
const ApiError = require("../utils/ApiError");
const slugify = require("../utils/slug");

const MAX_DEPTH = 3;

const notFound = () => new ApiError(404, "Category not found", { code: "NOT_FOUND" });

function slugOrThrow(slug, name) {
  const result = slug ?? slugify(name);
  if (!result) {
    throw new ApiError(400, "Validation failed", {
      code: "VALIDATION_ERROR",
      details: [{ field: "slug", message: "Send a slug, because one can't be made from this name" }],
    });
  }
  return result;
}

// Checks a category can go under this parent. `height` is the levels being placed: 1 for a new category.
async function assertValidParent(parentId, height, client) {
  const parent = await CategoryModel.findById(parentId, client);
  if (!parent) {
    throw new ApiError(400, "Parent category not found", { code: "INVALID_PARENT" });
  }
  // Products sit only on categories with no children.
  if (await CategoryModel.hasProducts(parentId, client)) {
    throw new ApiError(409, "This category has products, so it can't have sub-categories", {
      code: "CATEGORY_HAS_PRODUCTS",
    });
  }
  if ((await CategoryModel.getDepth(parentId, client)) + height > MAX_DEPTH) {
    throw new ApiError(400, `Categories can be at most ${MAX_DEPTH} levels deep`, { code: "CATEGORY_TOO_DEEP" });
  }
}

// GET /api/categories: active categories as a tree. An inactive category hides everything below it.
async function getTree(req, res) {
  const categories = (await CategoryModel.listAll()).filter((category) => category.is_active);

  const childrenOf = new Map();
  for (const category of categories) {
    const siblings = childrenOf.get(category.parent_id) ?? [];
    siblings.push(category);
    childrenOf.set(category.parent_id, siblings);
  }
  const build = (parentId) =>
    (childrenOf.get(parentId) ?? []).map((category) => ({
      ...CategoryModel.toPublicCategory(category),
      children: build(category.id),
    }));

  res.json({ categories: build(null) });
}

// GET /api/categories/:id/variant-options: what a variant in this category can choose, including from parents.
async function getVariantOptions(req, res) {
  if (!(await CategoryModel.isVisible(req.params.id))) throw notFound();
  res.json({ options: await CategoryModel.getEffectiveOptions(req.params.id) });
}

// GET /api/admin/categories: every live category as a flat list, including inactive ones.
async function adminList(req, res) {
  const categories = await CategoryModel.listAll();
  res.json({ categories: categories.map(CategoryModel.toAdminCategory) });
}

// POST /api/admin/categories
async function create(req, res) {
  const fields = { ...req.body, slug: slugOrThrow(req.body.slug, req.body.name) };

  const category = await db.transaction(async (client) => {
    await CategoryModel.lockTree(client);
    if (fields.parentId) await assertValidParent(fields.parentId, 1, client);
    return CategoryModel.create(fields, client);
  });

  res.status(201).json({ category: CategoryModel.toAdminCategory(category) });
}

// PATCH /api/admin/categories/:id: edits a category, or moves it by changing parentId.
async function update(req, res) {
  const { id } = req.params;

  const category = await db.transaction(async (client) => {
    await CategoryModel.lockTree(client);
    const current = await CategoryModel.findById(id, client);
    if (!current) throw notFound();

    const { parentId } = req.body;
    if (parentId && parentId !== current.parent_id) {
      const subtree = await CategoryModel.getSubtree(id, client);
      if (subtree.some((node) => node.id === parentId)) {
        throw new ApiError(400, "A category can't move under itself", { code: "INVALID_PARENT" });
      }
      const height = Math.max(...subtree.map((node) => node.level));
      await assertValidParent(parentId, height, client);
    }

    return CategoryModel.update(id, req.body, client);
  });

  res.json({ category: CategoryModel.toAdminCategory(category) });
}

// DELETE /api/admin/categories/:id: soft delete, refused while it has sub-categories or products.
async function remove(req, res) {
  const { id } = req.params;

  await db.transaction(async (client) => {
    await CategoryModel.lockTree(client);
    if (!(await CategoryModel.findById(id, client))) throw notFound();
    if (await CategoryModel.hasChildren(id, client)) {
      throw new ApiError(409, "Move or delete its sub-categories first", { code: "CATEGORY_HAS_CHILDREN" });
    }
    if (await CategoryModel.hasProducts(id, client)) {
      throw new ApiError(409, "This category has products. Deactivate it instead", {
        code: "CATEGORY_HAS_PRODUCTS",
      });
    }
    await CategoryModel.softDelete(id, client);
  });

  res.status(204).end();
}

// PUT /api/admin/categories/:id/variant-options: replaces the options set directly on this category.
async function setVariantOptions(req, res) {
  const { id } = req.params;
  const { options } = req.body;

  const effective = await db.transaction(async (client) => {
    if (!(await CategoryModel.findById(id, client))) throw notFound();

    const ids = options.map((option) => option.optionId);
    if ((await VariantOptionModel.countLive(ids, client)) !== ids.length) {
      throw new ApiError(400, "One or more variant options were not found", { code: "INVALID_OPTION" });
    }

    await CategoryModel.setOptions(id, options, client);
    return CategoryModel.getEffectiveOptions(id, client);
  });

  res.json({ options: effective });
}

module.exports = { getTree, getVariantOptions, adminList, create, update, remove, setVariantOptions };
