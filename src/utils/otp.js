// Generates and hashes 6-digit codes. The rules for using them are in services/otp.service.js.

const crypto = require("crypto");
const env = require("../config/env");

// Uses a secure random source; Math.random would be predictable.
const generateOtp = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

// Keyed, because a plain hash of a 6-digit code could be reversed instantly from a database leak.
// Bound to target and purpose so a code can't be reused for another account or action.
function hashOtp({ channel, target, purpose, code }) {
  return crypto
    .createHmac("sha256", env.JWT_ACCESS_SECRET)
    .update(["otp", channel, target, purpose, code].join(":"))
    .digest("hex");
}

// timingSafeEqual stops response time from revealing how much of a code matched.
function otpMatches(fields, storedHash) {
  const expected = Buffer.from(hashOtp(fields), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return expected.length === stored.length && crypto.timingSafeEqual(expected, stored);
}

module.exports = { generateOtp, hashOtp, otpMatches };
