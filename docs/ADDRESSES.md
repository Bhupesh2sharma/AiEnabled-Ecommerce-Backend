# Addresses

How saved addresses work. The code is the source of truth.

> Keep this file in sync with the code. Any change to address behaviour, endpoints, limits or error codes
> must update this document in the same change.

**Related:** [DATABASE.md](DATABASE.md) (tables), [AUTH.md](AUTH.md) (login and roles) and
[the Postman collection](../postman/Ecommerce-API.postman_collection.json) (runnable requests).

Customers and sellers each have an address book. Admins don't, because they don't buy or sell. India only for now.

## Endpoints

All paths start with `/api`.

| Method and path | Access | Purpose |
|---|---|---|
| `GET /states` | Public | State names and GST codes, for a form's dropdown |
| `GET /addresses` | Customer, seller | My addresses, defaults first, then newest |
| `POST /addresses` | Customer, seller | Add an address |
| `GET /addresses/:id` | Customer, seller | One of my addresses |
| `PATCH /addresses/:id` | Customer, seller | Edit, or make it a default; `null` clears an optional field |
| `DELETE /addresses/:id` | Customer, seller | Delete permanently |

Someone else's address returns 404, the same as one that doesn't exist.

## Fields

| Field | Rule |
|---|---|
| `fullName` | Required, at most 100 characters. Can be someone other than the account holder |
| `phone` | Required, an Indian mobile: `+91` then 10 digits starting 6 to 9. Not OTP-verified, because it can be someone else's |
| `addressLine1` | Required, at most 255 characters |
| `addressLine2`, `landmark` | Optional, at most 255 characters |
| `label` | Optional, at most 50 characters, e.g. Home |
| `city` | Required, at most 100 characters |
| `stateCode` | Required, a code from `GET /states` |
| `postalCode` | Required, 6 digits, not starting with 0 |
| `isDefaultShipping`, `isDefaultBilling` | Optional, and only `true` |

The server fills in `state` from `stateCode`, so the two can't disagree. Sending `state` or `countryCode` returns 400. Orders will compare state codes to choose CGST + SGST or IGST, which is why the state can't be free text.

The state list is in `src/utils/indianStates.js`. It leaves out old GST codes 25 (Daman and Diu, now part of 26) and 28 (Andhra Pradesh before it split, now 37), plus 97 and 99, which aren't places to deliver to.

## Defaults

- A user's first address becomes the default for both shipping and billing.
- To change a default, send `true` on a new or existing address. This clears the old one. The two defaults can be different addresses.
- A default can't be turned off directly, because choosing another address is what does that. Sending `false` returns 400.
- Deleting a default passes it to the most recently added address. Deleting the last address leaves none.

## Limits and deleting

- **Limit:** 20 addresses per user. Over the limit returns 409 `ADDRESS_LIMIT_REACHED`.
- **Deleting is permanent:** unlike most tables, there's no soft delete, so unused home addresses aren't kept. Orders will copy the address when placed, so past orders won't change.
- **Parallel requests:** every address change, and every change to a store's profile, first locks the user's row, so requests arriving together can't pass the limit, leave two defaults or break the pickup rules. The lock doesn't block logins.

## A store's pickup address

A seller chooses one of their addresses with `pickupAddressId` on `POST` or `PATCH /seller/profile`. It's where orders ship from, and it decides the tax with the delivery state.

| Rule | Result |
|---|---|
| It must be the seller's own | 400 `INVALID_PICKUP_ADDRESS` |
| Publishing needs one | `pickupAddress` is listed in 400 `PRODUCT_NOT_READY` |
| It can't be deleted, even with no products | 409 `ADDRESS_IN_USE`. Choose another first |
| It can't be cleared while products are published or paused | 409 `PICKUP_ADDRESS_REQUIRED`. Changing to another is fine |
| With a GSTIN, it must be in the GSTIN's state | 400 `PICKUP_STATE_MISMATCH` |
| A suspended store can't change it | 409 `PROFILE_SUSPENDED`. Choosing it as a personal default is still allowed |

- **GSTIN and state:** a GSTIN's first 2 digits are its state code. This is checked when choosing a pickup address, moving that address to another state, or adding or replacing a GSTIN. Sending a new GSTIN and pickup address together works. A store has one pickup address, so it ships from one state for now. Have the CA confirm this rule, and whether GSTINs starting with the old codes 25 or 28 still exist, because they can't match any address.
- **Changing it doesn't send an approved store back for review,** because that would hide all its products over an ordinary move. Admins can see the address.
- **Products already live:** publishing is checked once, so products published before this rule stay live with no pickup address. This can only be development data.

## Known gaps

- **PIN code and state can disagree:** a user could choose the wrong state, which could mean the wrong tax at checkout. Checking needs PIN code data from India Post or a courier API, so it fits best with shipping.
- **Addresses aren't checked as real:** only their format is.

## Errors

Errors use the format `{ message, code?, details? }`.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is invalid; `details` lists each one |
| 400 | `PICKUP_STATE_MISMATCH` | This would put a store's pickup address outside its GSTIN's state |
| 401 | `UNAUTHORIZED` | Not logged in |
| 403 | `FORBIDDEN` | Logged in as an admin |
| 404 | `NOT_FOUND` | The address doesn't exist, or isn't yours |
| 409 | `ADDRESS_LIMIT_REACHED` | Already 20 addresses |
| 409 | `ADDRESS_IN_USE` | This is a store's pickup address |
| 409 | `PROFILE_SUSPENDED` | A suspended store can't change its pickup address |

## Where the code is

| Location | Contents |
|---|---|
| `src/routes/address.routes.js` | URLs under `/addresses`. `/states` is in `catalog.routes.js`, with the other public read routes |
| `src/controllers/address.controller.js` | Defaults, the limit and the state name |
| `src/models/address.model.js` | SQL |
| `src/validators/address.validator.js` | Request rules |
| `src/utils/indianStates.js` | States and GST codes |
| `tests/addresses.test.js` | API and table tests |
