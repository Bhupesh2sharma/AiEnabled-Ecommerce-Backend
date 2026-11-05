# Cart

How customers' carts work. The code is the source of truth.

> Keep this file in sync with the code. Any change to cart behaviour, endpoints, limits or error codes
> must update this document in the same change.

**Related:** [DATABASE.md](DATABASE.md) (tables), [CATALOG.md](CATALOG.md) (what's on sale) and
[the Postman collection](../postman/Ecommerce-API.postman_collection.json) (runnable requests).

**Built so far:** viewing a cart and adding items. Changing, removing and merging a guest's cart come next.

## How it works

- **Only customers have a cart.** Accounts have one role, so a seller who wants to buy needs a separate customer account. This also stops a seller ordering their own products to fake sales.
- **Prices aren't stored.** Every view reads the current price, so a seller's change shows at once.
- **Adding doesn't hold stock.** Stock is only taken when an order is placed, so abandoned carts can't block other customers. A cart can go out of date, so every view rechecks it.
- **Items stay when they stop being for sale.** They're flagged rather than removed, so the customer knows what happened.
- **Several sellers:** one cart can hold products from many stores.

## Endpoints

All paths start with `/api`. Sellers and admins get 403.

| Method and path | Access | Purpose |
|---|---|---|
| `GET /cart` | Customer | The cart, with live details and totals |
| `POST /cart/items` | Customer | Add a variant, with `variantId` and `quantity` (default 1). Adding one already in the cart adds to its quantity. Returns the whole cart |

## The response

```json
{
  "items": [
    {
      "variantId": "...",
      "quantity": 2,
      "status": "available",
      "maxQuantity": 10,
      "productId": "...",
      "slug": "ceramic-mug",
      "title": "Ceramic Mug",
      "image": { "url": "...", "altText": "Front" },
      "options": [{ "name": "Size", "label": "M" }],
      "store": { "name": "Mug House", "slug": "mug-house" },
      "price": "300.00",
      "mrp": "600.00",
      "discountPercent": 50,
      "lineTotal": "600.00"
    }
  ],
  "totals": { "itemCount": 2, "subtotal": "600.00", "mrpTotal": "1200.00", "savings": "600.00" },
  "canCheckout": true
}
```

- **Order:** most recently added first. Adding more of an item doesn't move it.
- **Image:** the variant's own if it has one, otherwise the product's main image, or `null` if none are left.
- **Options:** sorted by name, with readable labels. A seller's custom value and a deleted value keep their labels.
- **Money:** added up in SQL, because NUMERIC is exact and JavaScript numbers aren't. Prices include GST, so no tax is added. Delivery charges aren't known until shipping exists.
- **Totals:** count only `available` items. `itemCount` adds up their quantities.
- **`canCheckout`:** true only if the cart has items and all are `available`, so nothing is dropped from an order without the customer seeing it.

## Item status

| `status` | When | `maxQuantity` | In totals |
|---|---|---|---|
| `available` | On sale, with enough stock | Up to 10 | Yes |
| `not_enough_stock` | In stock, but less than the quantity | The stock | No |
| `out_of_stock` | Stock is 0 | 0 | No |
| `unavailable` | The variant is inactive or deleted, or the product isn't on sale | 0 | No |

- **On sale** uses the same rules as the product page, from `src/models/browse.model.js`, so the two can't disagree. See "Browsing" in [CATALOG.md](CATALOG.md).
- **`unavailable`** doesn't say why, so a block reason or a seller's suspension stays private. Its `price`, `mrp`, `discountPercent` and `lineTotal` are `null`, because it can't be bought at any price.
- **Exact stock stays private:** `maxQuantity` is the smaller of 10 and the stock, so a customer learns stock only up to 10. SKUs, GST rates and HSN codes aren't returned either.

## Limits

- **10 per item.** Adding beyond this is refused rather than quietly capped.
- **50 different items in a cart.**
- **Parallel requests:** each add first locks the user's row, so requests arriving together can't pass a limit or lose a quantity. It doesn't lock the variant, because the cart doesn't take stock.

## Errors

Errors use the format `{ message, code?, details? }`.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is invalid; `details` lists each one |
| 401 | `UNAUTHORIZED` | Not logged in |
| 403 | `FORBIDDEN` | Logged in as a seller or admin |
| 409 | `PRODUCT_UNAVAILABLE` | The variant isn't on sale, or doesn't exist. The same answer for both, so hidden products can't be discovered |
| 409 | `OUT_OF_STOCK` | The variant's stock is 0 |
| 409 | `NOT_ENOUGH_STOCK` | The new quantity would pass the stock. `details[0].maxQuantity` says how many are allowed |
| 409 | `QUANTITY_LIMIT_REACHED` | The new quantity would pass 10. `details[0].maxQuantity` says how many are allowed |
| 409 | `CART_LIMIT_REACHED` | The cart already has 50 different items |

## Known gaps

- **Abandoned carts stay forever:** a few small rows per user. A scheduled cleanup or reminder emails can come later.
- **No "price dropped" notice:** the cart shows the current price, but doesn't say it changed.

## Where the code is

| Location | Contents |
|---|---|
| `src/routes/cart.routes.js` | URLs under `/cart` |
| `src/controllers/cart.controller.js` | Add rules, limits and the response |
| `src/models/cart.model.js` | SQL, including item status and totals |
| `src/models/browse.model.js` | The visibility rules, shared with browsing |
| `src/validators/cart.validator.js` | Request rules |
| `tests/cart.test.js` | Table and API tests |
