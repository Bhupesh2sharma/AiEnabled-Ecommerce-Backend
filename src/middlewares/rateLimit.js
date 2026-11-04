const { rateLimit } = require("express-rate-limit");
const ApiError = require("../utils/ApiError");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Counts per IP, in this process's memory: counters reset on restart and aren't shared between
// server instances. Running more than one instance needs a shared store such as Redis.
//
// Limits are generous because mobile carriers put many customers behind one IP. Limits per account
// and phone number (lockout, OTP cooldown) stay the main protection for an individual user.
function createLimiter({ windowMs, limit, message, ...options }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (req, res, next) => next(new ApiError(429, message, { code: "RATE_LIMITED" })),
    ...options,
  });
}

const limiters = {
  // Everything under /api/auth, including refresh and me.
  general: createLimiter({
    windowMs: 15 * MINUTE,
    limit: 300,
    message: "Too many requests. Try again later",
  }),

  // Guessing passwords and codes. Only failures count, so normal logins behind a shared IP aren't affected.
  credentials: createLimiter({
    windowMs: 15 * MINUTE,
    limit: 30,
    skipSuccessfulRequests: true,
    message: "Too many failed attempts. Try again later",
  }),

  // Each signup costs a bcrypt hash and a paid email.
  signup: createLimiter({
    windowMs: HOUR,
    limit: 20,
    message: "Too many signups from this network. Try again later",
  }),

  // Public catalog browsing. Much higher, because one page view makes several requests.
  publicRead: createLimiter({
    windowMs: MINUTE,
    limit: 300,
    message: "Too many requests. Try again shortly",
  }),

  // Each request can cost a paid SMS or email, so requests count whether or not a code is sent.
  otpSend: createLimiter({
    windowMs: HOUR,
    limit: 20,
    message: "Too many codes requested from this network. Try again later",
  }),
};

module.exports = limiters;
