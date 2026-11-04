# Catalog

How categories, brands and variant options work. The code is the source of truth.

> Keep this file in sync with the code. Any change to catalog behaviour, endpoints, limits or error codes
> must update this document in the same change.

**Related:** [DATABASE.md](DATABASE.md) (tables), [AUTH.md](AUTH.md) (login and roles) and
[the Postman collection](../postman/Ecommerce-API.postman_collection.json) (runnable requests).

**Built so far:** categories, brands and variant options. Seller products, images and public product browsing aren't built yet.

## Categories

Admins create categories through the API, so a new category needs no code change. They form a tree of at most 3 levels,
for example Electronics → Mobiles → Smartphones.

- **Slug:** made from the name if not sent. A name with no English letters or numbers, such as one in Hindi script, must send its own.
- **Names:** unique under the same parent, so "Mobiles" can exist under two different parents, each with its own slug.
- **Moving:** change `parentId`, or set it to `null` for the top level. A move is refused if it would go past 3 levels, or put a category under itself or its descendants.
- **Products:** sit only on categories with no children, so a category with products can't get sub-categories.
- **Deleting:** soft delete, refused while it has sub-categories or products. Deactivate it instead to hide it and keep its data.
- **Inactive:** hides the category and everything below it from customers. Admins still see it.

Only one change to the tree runs at a time, so two admins moving categories at once can't create a loop.

## Variant options

Admins define what variants can choose, such as Size or RAM, and which categories use them. New options need no code change.

```mermaid
flowchart LR
    A[Create option: Size] --> B[Add values: S, M, L]
    B --> C[Assign to a category: Clothing]
    C --> D[T-Shirts inherits it]
```

| Category | Options | Example variant |
|---|---|---|
| Clothing | Size, Colour | `{"size": "m", "colour": "red"}` |
| Smartphones | RAM, Storage, Colour | `{"ram": "8gb", "storage": "128gb", "colour": "black"}` |
| Books | None | `{}` |

- **Codes never change:** variants store each option's and value's `code`, so a name or label can be edited safely. Sending `code` in an edit returns 400. A code is made from the name or label if not sent.
- **Inheritance:** a category uses its own options plus its parents'. If both set the same option, the setting closest to the category wins, so T-Shirts can make Clothing's required Size optional. `inherited` in the response shows where each came from.
- **Assigning:** `PUT` replaces the options set directly on a category. Inherited ones aren't affected.
- **Custom values:** `allowCustomValues: true` lets sellers type their own value, for options such as colour. Sizes stay a fixed list.
- **Deleting a value:** new variants can't use it, and it leaves the public list. Existing variants keep their stored code.
- **Deleting an option:** refused while a live category uses it; remove it from those categories first. A new option could reuse a deleted option's code, so avoid doing that once variants exist.

## Brands

- Names are unique, ignoring case, and a slug is made from the name if not sent.
- Admins can create, edit and deactivate brands. Seller products will also add brands by name.
- Deleting is refused while live products use the brand; deactivate it instead.
- `GET /brands?q=ni` finds names starting with "ni", ignoring case. `%` and `_` are ordinary characters.

## Endpoints

All paths start with `/api`.

| Method and path | Access | Purpose |
|---|---|---|
| `GET /categories` | Public | Active categories as a tree |
| `GET /categories/:id/variant-options` | Public | Options and values a variant in this category can use, including inherited ones; 404 if the category or a parent is inactive |
| `GET /brands` | Public | Active brands by name; `q`, `page`, `limit` (at most 100, default 50) |
| `GET /admin/categories` | Admin | Every category as a flat list, including inactive |
| `POST /admin/categories` | Admin | Create a category |
| `PATCH /admin/categories/:id` | Admin | Edit or move a category; `null` clears an optional field |
| `DELETE /admin/categories/:id` | Admin | Soft delete a category |
| `PUT /admin/categories/:id/variant-options` | Admin | Replace the category's own options |
| `GET /admin/brands` | Admin | All brands, including inactive |
| `POST /admin/brands` | Admin | Create a brand |
| `PATCH /admin/brands/:id` | Admin | Edit a brand |
| `DELETE /admin/brands/:id` | Admin | Soft delete a brand |
| `GET /admin/variant-options` | Admin | All options with their values |
| `POST /admin/variant-options` | Admin | Create an option |
| `PATCH /admin/variant-options/:id` | Admin | Edit an option's name or `allowCustomValues` |
| `DELETE /admin/variant-options/:id` | Admin | Soft delete an option |
| `POST /admin/variant-options/:id/values` | Admin | Add a value |
| `PATCH /admin/variant-options/:id/values/:valueId` | Admin | Edit a value's label, colour or order |
| `DELETE /admin/variant-options/:id/values/:valueId` | Admin | Soft delete a value |

Request bodies are in `src/validators/catalog.validator.js` and the Postman collection. Image and logo fields hold an `http` or `https` URL for now; uploads arrive with image storage.

## Rate limits

Public catalog routes allow 300 requests per minute per IP, because one page view makes several requests. Over the limit
returns 429 `RATE_LIMITED`. Admin routes need a login and aren't limited.

## Errors

Errors use the format in [AUTH.md](AUTH.md).

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid input, including a field that can't be edited |
| 400 | `INVALID_PARENT` | Parent doesn't exist, or the move would put a category under itself |
| 400 | `CATEGORY_TOO_DEEP` | The result would go past 3 levels |
| 400 | `INVALID_OPTION` | An assigned option doesn't exist |
| 404 | `NOT_FOUND` | The category, brand, option or value doesn't exist |
| 409 | `CONFLICT` | A name, slug or code is taken, or a record is linked to other data |
| 409 | `CATEGORY_HAS_CHILDREN` | Move or delete its sub-categories first |
| 409 | `CATEGORY_HAS_PRODUCTS` | Can't delete it or give it sub-categories |
| 409 | `BRAND_IN_USE` | Products use this brand |
| 409 | `OPTION_IN_USE` | A category uses this option |

## Where the code is

| Location | Contents |
|---|---|
| `src/routes/catalog.routes.js`, `admin.routes.js` | Public and admin URLs |
| `src/controllers/category.controller.js` | Category tree rules and option assignment |
| `src/controllers/brand.controller.js`, `variantOption.controller.js` | Brands, options and values |
| `src/models/category.model.js` | SQL, including inherited options |
| `src/models/brand.model.js`, `variantOption.model.js` | SQL |
| `src/validators/catalog.validator.js` | Request rules |
| `tests/catalog.test.js` | API tests |
