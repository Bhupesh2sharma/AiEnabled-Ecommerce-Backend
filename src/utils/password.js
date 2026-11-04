// Password hashing with bcrypt.

const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const env = require("../config/env");

const hashPassword = (password) => bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);

let dummyHash;

// Accounts with no password (or no account at all) still cost one bcrypt comparison,
// so response time doesn't reveal which emails are registered.
async function verifyPassword(password, hash) {
  if (hash) return bcrypt.compare(password, hash);
  dummyHash ??= hashPassword(crypto.randomUUID());
  await bcrypt.compare(password, await dummyHash);
  return false;
}

module.exports = { hashPassword, verifyPassword };
