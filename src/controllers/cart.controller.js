// A customer's cart. Nothing is held: prices and stock are read live on every view, and stock is only
// taken when an order is placed. Only customers reach this, in cart.routes.js. Every change locks the
// user first, so a change and a removal arriving together can't bring back a removed item.
//
// Responses are built field by field, so seller-only data (exact stock, SKUs, GST details, why a product
// is hidden) can't reach customers by accident when a column is added.

const db = require("../config/db");
const BrowseModel = require("../models/browse.model");
const CartModel = require("../models/cart.model");
const UserModel = require("../models/user.model");
const ApiError = require("../utils/ApiError");

const MAX_PER_ITEM = 10;
const MAX_ITEMS = 50;

const notInCart = () => new ApiError(404, "This item isn't in your cart", { code: "NOT_FOUND" });

// Readable options, such as "Size: M". A seller's custom value carries its own label on the variant.
function toOptions(row, labels) {
  return Object.entries(row.options)
    .map(([optionCode, valueCode]) => {
      const known = labels.filter((label) => label.option_code === optionCode);
      const value = known.find((label) => label.value_code === valueCode);
      return {
        name: known[0]?.option_name ?? optionCode,
        label: value?.label ?? row.option_labels[optionCode] ?? valueCode,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// `maxQuantity` is the smaller of the limit and the stock, so exact stock above the limit stays private.
// An unavailable item has no price, because it can't be bought at any price.
function toItem(row, labels) {
  const unavailable = row.status === "unavailable";
  return {
    variantId: row.variant_id,
    quantity: row.quantity,
    status: row.status,
    maxQuantity: unavailable ? 0 : Math.min(MAX_PER_ITEM, row.stock_quantity),
    productId: row.product_id,
    slug: row.slug,
    title: row.title,
    image: row.image_url ? { url: row.image_url, altText: row.image_alt_text } : null,
    options: toOptions(row, labels),
    store: { name: row.store_name, slug: row.store_slug },
    price: unavailable ? null : row.selling_price,
    mrp: unavailable ? null : row.mrp,
    discountPercent: unavailable ? null : row.discount_percent,
    lineTotal: unavailable ? null : row.line_total,
  };
}

async function buildCart(userId) {
  const rows = await CartModel.listForUser(userId);
  const optionCodes = [...new Set(rows.flatMap((row) => Object.keys(row.options)))];
  const labels = optionCodes.length > 0 ? await BrowseModel.findOptionLabels(optionCodes) : [];
  const first = rows[0];
  return {
    items: rows.map((row) => toItem(row, labels)),
    totals: {
      itemCount: first?.item_count ?? 0,
      subtotal: first?.subtotal ?? "0.00",
      mrpTotal: first?.mrp_total ?? "0.00",
      savings: first?.savings ?? "0.00",
    },
    // All or nothing, so nothing is dropped from an order without the customer seeing it.
    canCheckout: rows.length > 0 && rows.every((row) => row.status === "available"),
  };
}

// GET /api/cart
async function getCart(req, res) {
  res.json(await buildCart(req.user.id));
}

// Tells the customer how many they can have, for a stock or limit problem.
function quantityError(message, code, maxQuantity) {
  return new ApiError(409, message, {
    code,
    details: [{ field: "quantity", message, maxQuantity }],
  });
}

// POST /api/cart/items: adding a variant already in the cart adds to its quantity.
async function addItem(req, res) {
  const { variantId, quantity } = req.body;

  await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);

    // The same answer for a hidden variant and an unknown one, so hidden products can't be discovered.
    const stock = await CartModel.findStockIfOnSale(variantId, client);
    if (stock === null) throw new ApiError(409, "This product isn't available", { code: "PRODUCT_UNAVAILABLE" });
    if (stock === 0) throw new ApiError(409, "This product is out of stock", { code: "OUT_OF_STOCK" });

    const current = await CartModel.findQuantity(req.user.id, variantId, client);
    if (current === null && (await CartModel.countItems(req.user.id, client)) >= MAX_ITEMS) {
      throw new ApiError(409, `Your cart can hold at most ${MAX_ITEMS} different items`, {
        code: "CART_LIMIT_REACHED",
      });
    }

    const total = (current ?? 0) + quantity;
    const maxQuantity = Math.min(MAX_PER_ITEM, stock);
    if (total > stock) {
      throw quantityError(`Only ${maxQuantity} of this item can be in your cart`, "NOT_ENOUGH_STOCK", maxQuantity);
    }
    if (total > MAX_PER_ITEM) {
      throw quantityError(`You can have at most ${MAX_PER_ITEM} of each item`, "QUANTITY_LIMIT_REACHED", maxQuantity);
    }

    await CartModel.setQuantity(req.user.id, variantId, total, client);
  });

  res.json(await buildCart(req.user.id));
}

// PATCH /api/cart/items/:variantId: sets the quantity. Lowering is always allowed for an item on sale, so a
// customer can fix one that ran short. An unavailable item can only be removed.
async function changeItem(req, res) {
  const { variantId } = req.params;
  const { quantity } = req.body;

  await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);

    const current = await CartModel.findQuantity(req.user.id, variantId, client);
    if (current === null) throw notInCart();

    const stock = await CartModel.findStockIfOnSale(variantId, client);
    if (stock === null) throw new ApiError(409, "This product isn't available", { code: "PRODUCT_UNAVAILABLE" });

    if (quantity > current) {
      if (stock === 0) throw new ApiError(409, "This product is out of stock", { code: "OUT_OF_STOCK" });
      if (quantity > stock) {
        const maxQuantity = Math.min(MAX_PER_ITEM, stock);
        throw quantityError(`Only ${maxQuantity} of this item can be in your cart`, "NOT_ENOUGH_STOCK", maxQuantity);
      }
    }

    await CartModel.setQuantity(req.user.id, variantId, quantity, client);
  });

  res.json(await buildCart(req.user.id));
}

// DELETE /api/cart/items/:variantId: works whatever the item's status.
async function removeItem(req, res) {
  const removed = await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);
    return CartModel.removeItem(req.user.id, req.params.variantId, client);
  });
  if (!removed) throw notInCart();

  res.json(await buildCart(req.user.id));
}

// DELETE /api/cart: emptying an empty cart is fine.
async function clearCart(req, res) {
  await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);
    await CartModel.clear(req.user.id, client);
  });

  res.json(await buildCart(req.user.id));
}

// POST /api/cart/merge: adds what a guest put in their cart before logging in. The browser may hold old
// data, so one bad item doesn't refuse the rest: it's lowered to fit, or skipped and listed. Keeping the
// larger quantity, rather than adding, means logging in twice doesn't double anything.
async function mergeCart(req, res) {
  // A variant sent twice counts once, at its larger quantity.
  const wanted = new Map();
  for (const { variantId, quantity } of req.body.items) {
    wanted.set(variantId, Math.max(wanted.get(variantId) ?? 0, quantity));
  }

  const skipped = await db.transaction(async (client) => {
    await UserModel.lockForChange(req.user.id, client);

    const stocks = await CartModel.findStocksOnSale([...wanted.keys()], client);
    const inCart = await CartModel.findQuantities(req.user.id, client);
    let count = inCart.size;
    const notAdded = [];

    for (const [variantId, quantity] of wanted) {
      const stock = stocks.get(variantId) ?? 0; // hidden or unknown is treated like sold out
      const current = inCart.get(variantId);

      if (stock === 0 || (current === undefined && count >= MAX_ITEMS)) {
        notAdded.push(variantId);
      } else {
        const fitted = Math.min(quantity, MAX_PER_ITEM, stock);
        // An existing quantity is left for the customer to change, even if it has since run short.
        if (current === undefined || fitted > current) {
          await CartModel.setQuantity(req.user.id, variantId, fitted, client);
        }
        if (current === undefined) count += 1;
      }
    }
    return notAdded;
  });

  res.json({ ...(await buildCart(req.user.id)), skipped });
}

module.exports = { getCart, addItem, changeItem, removeItem, clearCart, mergeCart };
