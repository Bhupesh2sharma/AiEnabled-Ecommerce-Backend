// Points the tests at a disposable database. Load this before anything from src/.

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error("Set TEST_DATABASE_URL to a disposable database (not DATABASE_URL). Its data is wiped.");
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.BCRYPT_SALT_ROUNDS = "4";
process.env.EMAIL_DRIVER = "console";
process.env.SMS_DRIVER = "console";
process.env.GOOGLE_CLIENT_ID = "test-client";
