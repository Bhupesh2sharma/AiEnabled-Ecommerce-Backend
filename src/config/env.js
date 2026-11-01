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

  // Frontend origin allowed by CORS (cookies are only sent to this origin)
  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:3000",

  // Auth
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
  JWT_ACCESS_EXPIRES_IN: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  REFRESH_TOKEN_EXPIRES_DAYS: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 7,
  BCRYPT_SALT_ROUNDS: Number(process.env.BCRYPT_SALT_ROUNDS) || 12,
  TERMS_VERSION: process.env.TERMS_VERSION || "v1",
};

module.exports = env;
