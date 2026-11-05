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
- **Parallel requests:** every change first locks the user's row, so requests arriving together can't pass the limit or leave two defaults. The lock doesn't block logins.

## Known gaps

- **PIN code and state can disagree:** a user could choose the wrong state, which could mean the wrong tax at checkout. Checking needs PIN code data from India Post or a courier API, so it fits best with shipping.
- **Addresses aren't checked as real:** only their format is.
- **A store's pickup address has no protection yet:** deleting it clears the store's pickup address. Step 3 of the plan refuses this.

## Errors

Errors use the format `{ message, code?, details? }`.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is invalid; `details` lists each one |
| 401 | `UNAUTHORIZED` | Not logged in |
| 403 | `FORBIDDEN` | Logged in as an admin |
| 404 | `NOT_FOUND` | The address doesn't exist, or isn't yours |
| 409 | `ADDRESS_LIMIT_REACHED` | Already 20 addresses |

## Where the code is

| Location | Contents |
|---|---|
| `src/routes/address.routes.js` | URLs under `/addresses`. `/states` is in `catalog.routes.js`, with the other public read routes |
| `src/controllers/address.controller.js` | Defaults, the limit and the state name |
| `src/models/address.model.js` | SQL |
| `src/validators/address.validator.js` | Request rules |
| `src/utils/indianStates.js` | States and GST codes |
| `tests/addresses.test.js` | API and table tests |
