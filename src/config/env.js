const REQUIRED = ["DATABASE_URL", "JWT_ACCESS_SECRET"];

for (const name of REQUIRED) {
  if (!process.env[name]) {
    throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  }
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT) || 8080,
  DATABASE_URL: process.env.DATABASE_URL,

  // Number of reverse proxies in front of the app (0 = none). Used to find the client IP.
  TRUST_PROXY: Number(process.env.TRUST_PROXY) || 0,

  // Frontend origin allowed by CORS (cookies are only sent to this origin)
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",

  // Auth
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  REFRESH_TOKEN_EXPIRES_DAYS: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 7,
  BCRYPT_SALT_ROUNDS: Number(process.env.BCRYPT_SALT_ROUNDS) || 12,
  TERMS_VERSION: process.env.TERMS_VERSION || "v1",

  // Email: console (prints the OTP) or resend
  EMAIL_DRIVER: process.env.EMAIL_DRIVER || "console",
  EMAIL_FROM: process.env.EMAIL_FROM,
  RESEND_API_KEY: process.env.RESEND_API_KEY,

  // SMS: console (prints the OTP) or fast2sms
  SMS_DRIVER: process.env.SMS_DRIVER || "console",
  FAST2SMS_API_KEY: process.env.FAST2SMS_API_KEY,

  // Google login is unavailable until this is set
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
};

function requireForDriver(driverName, driver, allowed) {
  if (!(driver in allowed)) {
    throw new Error(`${driverName} must be one of: ${Object.keys(allowed).join(", ")}`);
  }
  for (const name of allowed[driver]) {
    if (!env[name]) throw new Error(`${name} is required when ${driverName}=${driver}`);
  }
  // The console drivers write login codes to the logs.
  if (env.NODE_ENV === "production" && driver === "console") {
    throw new Error(`${driverName}=console is not allowed in production`);
  }
}

requireForDriver("EMAIL_DRIVER", env.EMAIL_DRIVER, {
  console: [],
  resend: ["RESEND_API_KEY", "EMAIL_FROM"],
});
requireForDriver("SMS_DRIVER", env.SMS_DRIVER, { console: [], fast2sms: ["FAST2SMS_API_KEY"] });

module.exports = env;
