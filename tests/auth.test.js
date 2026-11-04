// End-to-end tests of the auth API against a real Postgres.
// TEST_DATABASE_URL must point at a migrated, disposable database: all users are deleted.

const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");

require("./testEnv");

const jwt = require("jsonwebtoken");
const app = require("../src/app");
const db = require("../src/config/db");
const google = require("../src/services/google");
const limiters = require("../src/middlewares/rateLimit");

let server;
let baseUrl;
let logged = [];
const originalLog = console.log;
const PASSWORD = "correct-horse-battery";

before(async () => {
  console.log = (...args) => logged.push(args.join(" "));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  console.log = originalLog;
  await new Promise((resolve) => server.close(resolve));
  await db.pool.end();
});

beforeEach(async () => {
  logged = [];
  await db.query("TRUNCATE users, otp_codes CASCADE");
  for (const limiter of Object.values(limiters)) limiter.resetKey("127.0.0.1");
});

async function api(method, path, { body, token, cookie } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body && { "Content-Type": "application/json" }),
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(cookie && { Cookie: cookie }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get("set-cookie"),
    headers: response.headers,
  };
}

const cookieFrom = (res) => res.setCookie.split(";")[0];

// Reads the code the console driver printed for this target.
async function codeFor(target) {
  for (let i = 0; i < 100; i++) {
    const line = logged.findLast((entry) => entry.includes(`to=${target}`));
    if (line) {
      logged = logged.filter((entry) => entry !== line);
      return line.match(/\b\d{6}\b/)[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No code logged for ${target}`);
}

// Lets a background send finish, then reports whether it printed anything for this target.
async function sentTo(target) {
  await new Promise((resolve) => setTimeout(resolve, 150));
  return logged.some((entry) => entry.includes(`to=${target}`));
}

const wrongCode = (code) => (code === "000000" ? "000001" : "000000");

const signup = (overrides = {}) =>
  api("POST", "/auth/signup", {
    body: { name: "Asha", email: "asha@example.com", password: PASSWORD, termsAccepted: true, ...overrides },
  });

async function makeAdmin(email = "root@example.com") {
  const res = await signup({ email });
  await db.query("UPDATE users SET role = 'admin', email_verified_at = NOW() WHERE email = $1", [email]);
  return res.body.accessToken;
}

const mockGoogle = (identity = {}) => {
  google.verifyIdToken = async () => ({
    providerUserId: "google-1",
    email: "asha@example.com",
    emailVerified: true,
    name: "Asha G",
    avatarUrl: null,
    ...identity,
  });
};

test("signup returns a session, hides the hash and sends a verification code", async () => {
  const res = await signup({ email: "Asha@Example.com" });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.email, "asha@example.com");
  assert.equal(res.body.user.role, "customer");
  assert.equal(res.body.user.emailVerified, false);
  assert.equal(res.body.user.password_hash, undefined);
  assert.match(res.setCookie, /HttpOnly/);
  assert.match(res.setCookie, /Path=\/api\/auth/);
  assert.match(res.setCookie, /SameSite=Lax/);

  const { exp, iat } = jwt.decode(res.body.accessToken);
  assert.equal(exp - iat, 15 * 60);

  const { rows } = await db.query("SELECT password_hash FROM users");
  assert.match(rows[0].password_hash, /^\$2[aby]\$/);
  assert.ok(await codeFor("asha@example.com"));
});

test("signup rejects missing terms, the admin role, short passwords and duplicate emails", async () => {
  assert.equal((await signup({ termsAccepted: false })).status, 400);
  assert.equal((await signup({ termsAccepted: undefined })).status, 400);
  assert.equal((await signup({ role: "admin" })).status, 400);
  assert.equal((await signup({ password: "short" })).status, 400);
  assert.equal((await signup({ password: "x".repeat(73) })).status, 400);

  assert.equal((await signup()).status, 201);
  const dup = await signup({ email: "ASHA@example.com" });
  assert.equal(dup.status, 409);
});

test("parallel signups with one email produce one account and a 409", async () => {
  const results = await Promise.all([signup(), signup()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test("login succeeds and failures look the same for wrong password and unknown email", async () => {
  await signup();
  const ok = await api("POST", "/auth/login", { body: { email: "asha@example.com", password: PASSWORD } });
  assert.equal(ok.status, 200);

  const wrong = await api("POST", "/auth/login", { body: { email: "asha@example.com", password: "nope-nope" } });
  const unknown = await api("POST", "/auth/login", { body: { email: "no@example.com", password: "nope-nope" } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test("five failed logins lock the account, even for the right password", async () => {
  await signup();
  const attempt = (password) => api("POST", "/auth/login", { body: { email: "asha@example.com", password } });
  for (let i = 0; i < 5; i++) assert.equal((await attempt("wrong-password")).status, 401);
  assert.equal((await attempt(PASSWORD)).status, 429);

  await db.query("UPDATE users SET locked_until = NOW() - INTERVAL '1 minute'");
  assert.equal((await attempt(PASSWORD)).status, 200);
});

test("a suspended user cannot log in, refresh or use an access token", async () => {
  const session = await signup();
  await db.query("UPDATE users SET status = 'suspended'");

  const login = await api("POST", "/auth/login", { body: { email: "asha@example.com", password: PASSWORD } });
  assert.equal(login.status, 403);
  assert.equal((await api("POST", "/auth/refresh", { cookie: cookieFrom(session) })).status, 401);
  assert.equal((await api("GET", "/auth/me", { token: session.body.accessToken })).status, 401);
});

test("refresh rotates the token and the old one stops working", async () => {
  const session = await signup();
  const old = cookieFrom(session);

  const refreshed = await api("POST", "/auth/refresh", { cookie: old });
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.accessToken);
  assert.notEqual(cookieFrom(refreshed), old);

  const replay = await api("POST", "/auth/refresh", { cookie: old });
  assert.equal(replay.status, 401);
  assert.equal((await api("POST", "/auth/refresh", { cookie: cookieFrom(refreshed) })).status, 200);
});

test("parallel refreshes of one token only succeed once", async () => {
  const cookie = cookieFrom(await signup());
  const results = await Promise.all([1, 2, 3, 4].map(() => api("POST", "/auth/refresh", { cookie })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test("refresh rejects missing, unknown and expired tokens", async () => {
  assert.equal((await api("POST", "/auth/refresh")).status, 401);
  assert.equal((await api("POST", "/auth/refresh", { cookie: "refreshToken=nope" })).status, 401);

  const session = await signup();
  await db.query("UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 second'");
  assert.equal((await api("POST", "/auth/refresh", { cookie: cookieFrom(session) })).status, 401);
});

test("refresh tokens are stored hashed", async () => {
  const cookie = cookieFrom(await signup());
  const { rows } = await db.query("SELECT token_hash FROM refresh_tokens");
  assert.equal(rows[0].token_hash.length, 64);
  assert.ok(!cookie.includes(rows[0].token_hash));
});

test("logout ends one session and logout-all ends every session", async () => {
  const first = await signup();
  const login = () => api("POST", "/auth/login", { body: { email: "asha@example.com", password: PASSWORD } });
  const second = await login();
  const third = await login();
  const refresh = (res) => api("POST", "/auth/refresh", { cookie: cookieFrom(res) });

  assert.equal((await api("POST", "/auth/logout", { cookie: cookieFrom(first) })).status, 204);
  assert.equal((await refresh(first)).status, 401);
  assert.equal((await api("POST", "/auth/logout")).status, 204);

  assert.equal((await api("POST", "/auth/logout-all")).status, 401);
  assert.equal((await api("POST", "/auth/logout-all", { token: third.body.accessToken })).status, 204);
  assert.equal((await refresh(second)).status, 401);
  assert.equal((await refresh(third)).status, 401);
});

test("authenticate rejects missing, tampered, expired and wrongly signed tokens", async () => {
  const { body } = await signup();
  const me = (token) => api("GET", "/auth/me", { token });
  assert.equal((await me(body.accessToken)).status, 200);
  assert.equal((await me()).status, 401);
  assert.equal((await me(`${body.accessToken}x`)).status, 401);

  const { sub } = jwt.decode(body.accessToken);
  const secret = process.env.JWT_ACCESS_SECRET;
  assert.equal((await me(jwt.sign({}, secret, { subject: sub, expiresIn: -1 }))).status, 401);
  assert.equal((await me(jwt.sign({}, "other-secret", { subject: sub }))).status, 401);
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.`;
  assert.equal((await me(none)).status, 401);
});

test("email verification marks the account verified and the code works once", async () => {
  await signup();
  const code = await codeFor("asha@example.com");

  const wrong = await api("POST", "/auth/otp/verify-email", {
    body: { email: "asha@example.com", code: wrongCode(code) },
  });
  assert.equal(wrong.status, 400);

  const ok = await api("POST", "/auth/otp/verify-email", { body: { email: "asha@example.com", code } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.emailVerified, true);

  const again = await api("POST", "/auth/otp/verify-email", { body: { email: "asha@example.com", code } });
  assert.equal(again.status, 400);
});

test("a code stops working after five wrong attempts", async () => {
  await signup();
  const code = await codeFor("asha@example.com");
  const verify = (c) => api("POST", "/auth/otp/verify-email", { body: { email: "asha@example.com", code: c } });
  for (let i = 0; i < 5; i++) assert.equal((await verify(wrongCode(code))).status, 400);
  assert.equal((await verify(code)).status, 400);
});

test("expired codes are rejected and codes are stored hashed", async () => {
  await signup();
  const code = await codeFor("asha@example.com");
  const { rows } = await db.query("SELECT code_hash, expires_at - created_at AS ttl FROM otp_codes");
  assert.notEqual(rows[0].code_hash, code);
  assert.equal(rows[0].ttl.minutes, 5);

  await db.query("UPDATE otp_codes SET expires_at = NOW() - INTERVAL '1 second'");
  const res = await api("POST", "/auth/otp/verify-email", { body: { email: "asha@example.com", code } });
  assert.equal(res.status, 400);
});

test("a code for one purpose can't be used for another", async () => {
  await signup();
  const code = await codeFor("asha@example.com");
  const res = await api("POST", "/auth/password/reset", {
    body: { email: "asha@example.com", code, newPassword: "a-brand-new-password" },
  });
  assert.equal(res.status, 400);
});

test("otp/send gives the same response for unknown accounts and sends nothing", async () => {
  await signup();
  const known = await api("POST", "/auth/otp/send", {
    body: { channel: "email", target: "asha@example.com", purpose: "login" },
  });
  const unknown = await api("POST", "/auth/otp/send", {
    body: { channel: "email", target: "ghost@example.com", purpose: "login" },
  });
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, unknown.body);
  assert.equal(await sentTo("ghost@example.com"), false);
});

test("the resend cooldown limits sends without revealing the account", async () => {
  await signup();
  await codeFor("asha@example.com");
  const res = await api("POST", "/auth/otp/send", {
    body: { channel: "email", target: "asha@example.com", purpose: "verify_email" },
  });
  assert.equal(res.status, 200);
  assert.equal(await sentTo("asha@example.com"), false);

  await db.query("UPDATE otp_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  await api("POST", "/auth/otp/send", {
    body: { channel: "email", target: "asha@example.com", purpose: "verify_email" },
  });
  assert.equal(await sentTo("asha@example.com"), true);
});

test("sending a new code cancels the previous one", async () => {
  await signup();
  const first = await codeFor("asha@example.com");
  await db.query("UPDATE otp_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  await api("POST", "/auth/otp/send", {
    body: { channel: "email", target: "asha@example.com", purpose: "verify_email" },
  });
  const second = await codeFor("asha@example.com");
  if (first !== second) {
    const stale = await api("POST", "/auth/otp/verify-email", { body: { email: "asha@example.com", code: first } });
    assert.equal(stale.status, 400);
  }
  const fresh = await api("POST", "/auth/otp/verify-email", { body: { email: "asha@example.com", code: second } });
  assert.equal(fresh.status, 200);
});

test("at most five codes are sent per hour", async () => {
  const body = { channel: "phone", target: "+919876543210", purpose: "login" };
  for (let i = 0; i < 6; i++) {
    await db.query("UPDATE otp_codes SET created_at = created_at - INTERVAL '61 seconds'");
    await api("POST", "/auth/otp/send", { body });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM otp_codes");
  assert.equal(rows[0].n, 5);
});

test("parallel sends only issue one code", async () => {
  const body = { channel: "phone", target: "+919876543210", purpose: "login" };
  await Promise.all([1, 2, 3, 4].map(() => api("POST", "/auth/otp/send", { body })));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM otp_codes");
  assert.equal(rows[0].n, 1);
});

test("phone OTP signs up with no email, then logs in; details are needed only to sign up", async () => {
  const phone = "+919876543210";
  await api("POST", "/auth/otp/send", { body: { channel: "phone", target: phone, purpose: "login" } });
  const code = await codeFor(phone);

  const bad = await api("POST", "/auth/otp/login", { body: { channel: "phone", target: phone, code: wrongCode(code) } });
  assert.equal(bad.body.code, "INVALID_OTP");

  const noDetails = await api("POST", "/auth/otp/login", { body: { channel: "phone", target: phone, code } });
  assert.equal(noDetails.status, 400);
  assert.equal(noDetails.body.code, "SIGNUP_DETAILS_REQUIRED");

  const created = await api("POST", "/auth/otp/login", {
    body: { channel: "phone", target: phone, code, name: "Ravi", termsAccepted: true, role: "seller" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.email, null);
  assert.equal(created.body.user.phoneVerified, true);
  assert.equal(created.body.user.role, "seller");
  assert.equal(created.body.user.hasPassword, false);

  await db.query("UPDATE otp_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  await api("POST", "/auth/otp/send", { body: { channel: "phone", target: phone, purpose: "login" } });
  const second = await codeFor(phone);
  const login = await api("POST", "/auth/otp/login", { body: { channel: "phone", target: phone, code: second } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, created.body.user.id);
});

test("phone signup can't use terms: false or the admin role", async () => {
  const body = { channel: "phone", target: "+919876543210", code: "123456", name: "Ravi" };
  assert.equal((await api("POST", "/auth/otp/login", { body: { ...body, termsAccepted: false } })).status, 400);
  const admin = await api("POST", "/auth/otp/login", { body: { ...body, termsAccepted: true, role: "admin" } });
  assert.equal(admin.body.code, "VALIDATION_ERROR");
});

test("admins can't get a phone OTP", async () => {
  const token = await makeAdmin();
  const phone = "+919876543211";
  await api("POST", "/auth/phone/send-verification", { token, body: { phone } });
  const code = await codeFor(phone);
  await api("POST", "/auth/phone/verify", { token, body: { phone, code } });
  logged = [];

  const res = await api("POST", "/auth/otp/send", { body: { channel: "phone", target: phone, purpose: "login" } });
  assert.equal(res.status, 200);
  assert.equal(await sentTo(phone), false);
});

test("email OTP logs in, including for an admin, but never creates an account", async () => {
  await makeAdmin();
  await api("POST", "/auth/otp/send", { body: { channel: "email", target: "root@example.com", purpose: "login" } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const code = await codeFor("root@example.com");
  const res = await api("POST", "/auth/otp/login", { body: { channel: "email", target: "root@example.com", code } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.role, "admin");

  const ghost = await api("POST", "/auth/otp/login", { body: { channel: "email", target: "ghost@example.com", code } });
  assert.equal(ghost.status, 400);
});

test("email OTP login on an unverified account cuts off whoever registered it", async () => {
  const attacker = await signup();
  await codeFor("asha@example.com");

  await api("POST", "/auth/otp/send", { body: { channel: "email", target: "asha@example.com", purpose: "login" } });
  const code = await codeFor("asha@example.com");
  const owner = await api("POST", "/auth/otp/login", { body: { channel: "email", target: "asha@example.com", code } });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.user.emailVerified, true);
  assert.equal(owner.body.user.hasPassword, false);

  const login = await api("POST", "/auth/login", { body: { email: "asha@example.com", password: PASSWORD } });
  assert.equal(login.status, 401);
  assert.equal((await api("POST", "/auth/refresh", { cookie: cookieFrom(attacker) })).status, 401);
});

test("password reset changes the password and ends every session", async () => {
  const session = await signup();
  await codeFor("asha@example.com"); // the signup's verification code
  await api("POST", "/auth/otp/send", { body: { channel: "email", target: "asha@example.com", purpose: "reset_password" } });
  const code = await codeFor("asha@example.com");

  const reset = await api("POST", "/auth/password/reset", {
    body: { email: "asha@example.com", code, newPassword: "a-brand-new-password" },
  });
  assert.equal(reset.status, 200);

  const login = (password) => api("POST", "/auth/login", { body: { email: "asha@example.com", password } });
  assert.equal((await login(PASSWORD)).status, 401);
  assert.equal((await login("a-brand-new-password")).status, 200);
  assert.equal((await api("POST", "/auth/refresh", { cookie: cookieFrom(session) })).status, 401);
});

test("adding a phone needs login and an OTP, and a taken number is refused", async () => {
  const { body } = await signup();
  const phone = "+919876543212";
  const send = (token, p = phone) => api("POST", "/auth/phone/send-verification", { token, body: { phone: p } });

  assert.equal((await send()).status, 401);
  assert.equal((await send(body.accessToken)).status, 200);
  assert.equal((await send(body.accessToken)).status, 429);

  const code = await codeFor(phone);
  const verified = await api("POST", "/auth/phone/verify", { token: body.accessToken, body: { phone, code } });
  assert.equal(verified.body.user.phone, phone);
  assert.equal(verified.body.user.phoneVerified, true);

  const other = await signup({ email: "other@example.com" });
  assert.equal((await send(other.body.accessToken)).status, 409);
});

test("Google creates a verified user, needs terms, and logs the same user in afterwards", async () => {
  mockGoogle();
  const noTerms = await api("POST", "/auth/google", { body: { idToken: "t" } });
  assert.equal(noTerms.body.code, "TERMS_REQUIRED");

  const created = await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true, role: "seller" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.user.emailVerified, true);
  assert.equal(created.body.user.role, "seller");

  const again = await api("POST", "/auth/google", { body: { idToken: "t", role: "customer" } });
  assert.equal(again.status, 200);
  assert.equal(again.body.user.id, created.body.user.id);
  assert.equal(again.body.user.role, "seller");
});

test("Google links to a verified account and keeps its password", async () => {
  mockGoogle();
  const session = await signup();
  await api("POST", "/auth/otp/verify-email", {
    body: { email: "asha@example.com", code: await codeFor("asha@example.com") },
  });

  const res = await api("POST", "/auth/google", { body: { idToken: "t" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.id, session.body.user.id);
  assert.equal(res.body.user.hasPassword, true);
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users");
  assert.equal(rows[0].n, 1);
});

test("Google on an unverified account cuts off whoever registered it", async () => {
  mockGoogle();
  const attacker = await signup();
  const res = await api("POST", "/auth/google", { body: { idToken: "t" } });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.hasPassword, false);

  const login = await api("POST", "/auth/login", { body: { email: "asha@example.com", password: PASSWORD } });
  assert.equal(login.status, 401);
  assert.equal((await api("POST", "/auth/refresh", { cookie: cookieFrom(attacker) })).status, 401);
});

test("a second Google identity can't be linked to an account that already has one", async () => {
  mockGoogle();
  await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true } });
  mockGoogle({ providerUserId: "google-2" });
  const res = await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true } });
  assert.equal(res.status, 409);
});

test("Google refuses admins and unverified Google emails, without linking", async () => {
  await makeAdmin("asha@example.com");
  mockGoogle();
  const admin = await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true } });
  assert.equal(admin.status, 403);
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM auth_providers");
  assert.equal(rows[0].n, 0);

  mockGoogle({ email: "new@example.com", emailVerified: false });
  const unverified = await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true } });
  assert.equal(unverified.status, 401);
});

test("a Google identity from a soft-deleted account can sign up again", async () => {
  mockGoogle();
  await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true } });
  await db.query("UPDATE users SET deleted_at = NOW()");
  const res = await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true } });
  assert.equal(res.status, 201);
});

let phoneCounter = 0;
const markContactsVerified = (userId) =>
  db.query("UPDATE users SET email_verified_at = NOW(), phone = $2, phone_verified_at = NOW() WHERE id = $1", [
    userId,
    `+9198${String(++phoneCounter).padStart(8, "0")}`,
  ]);

const storeBody = { storeName: "RK Electronics", storeSlug: "rk-electronics", legalBusinessName: "RK Pvt Ltd" };

test("sellers complete a profile that starts pending; others are refused", async () => {
  const customer = await signup();
  const seller = await signup({ email: "seller@example.com", role: "seller" });
  const create = (token, body = storeBody) => api("POST", "/seller/profile", { token, body });

  assert.equal((await create()).status, 401);
  assert.equal((await create(customer.body.accessToken)).status, 403);

  await markContactsVerified(seller.body.user.id);
  const res = await create(seller.body.accessToken, {
    ...storeBody,
    verificationStatus: "approved",
    commissionRate: 0,
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.profile.verificationStatus, "pending");
  assert.equal(res.body.profile.commissionRate, "10.00");

  assert.equal((await create(seller.body.accessToken)).status, 409);
});

test("seller profile rejects a taken slug, a bad slug and someone else's address", async () => {
  const one = await signup({ email: "one@example.com", role: "seller" });
  const two = await signup({ email: "two@example.com", role: "seller" });
  await markContactsVerified(one.body.user.id);
  await markContactsVerified(two.body.user.id);
  await api("POST", "/seller/profile", { token: one.body.accessToken, body: storeBody });

  const create = (body) => api("POST", "/seller/profile", { token: two.body.accessToken, body });
  const taken = await create(storeBody);
  assert.equal(taken.status, 409);
  assert.match(taken.body.message, /store URL/);
  assert.equal((await create({ ...storeBody, storeSlug: "Bad Slug" })).status, 400);

  const { rows } = await db.query(
    `INSERT INTO addresses (user_id, full_name, phone, address_line1, city, state, postal_code, country_code)
     VALUES ($1, 'A', '+919876543213', 'L1', 'C', 'S', '1', 'IN') RETURNING id`,
    [one.body.user.id]
  );
  const res = await create({ ...storeBody, storeSlug: "two", pickupAddressId: rows[0].id });
  assert.equal(res.body.code, "INVALID_PICKUP_ADDRESS");
});

test("only admins can create admins, and the new admin can log in", async () => {
  const body = { name: "Second", email: "second@example.com", password: PASSWORD };
  const customer = await signup();

  assert.equal((await api("POST", "/admin/admins", { body })).status, 401);
  assert.equal((await api("POST", "/admin/admins", { token: customer.body.accessToken, body })).status, 403);

  const token = await makeAdmin();
  const res = await api("POST", "/admin/admins", { token, body });
  assert.equal(res.status, 201);
  assert.equal(res.body.user.role, "admin");

  const login = await api("POST", "/auth/login", { body: { email: body.email, password: PASSWORD } });
  assert.equal(login.status, 200);
  assert.equal((await api("POST", "/admin/admins", { token, body })).status, 409);
});

const profileAs = (token) => api("POST", "/seller/profile", { token, body: storeBody });
const missingFields = (res) => res.body.details.map((d) => d.field);

async function verifyPhoneWithOtp(token, phone) {
  assert.equal((await api("POST", "/auth/phone/send-verification", { token, body: { phone } })).status, 200);
  const res = await api("POST", "/auth/phone/verify", { token, body: { phone, code: await codeFor(phone) } });
  assert.equal(res.status, 200);
}

test("an email seller must verify both email and phone before creating a profile", async () => {
  const seller = await signup({ email: "seller@example.com", role: "seller" });
  const token = seller.body.accessToken;

  const neither = await profileAs(token);
  assert.equal(neither.status, 403);
  assert.equal(neither.body.code, "SELLER_VERIFICATION_REQUIRED");
  assert.deepEqual(missingFields(neither), ["email", "phone"]);

  const code = await codeFor("seller@example.com");
  await api("POST", "/auth/otp/verify-email", { body: { email: "seller@example.com", code } });
  assert.deepEqual(missingFields(await profileAs(token)), ["phone"]);

  await verifyPhoneWithOtp(token, "+919811111111");
  assert.equal((await profileAs(token)).status, 201);
});

test("a Google seller skips email verification but still needs phone OTP", async () => {
  mockGoogle();
  const seller = await api("POST", "/auth/google", { body: { idToken: "t", termsAccepted: true, role: "seller" } });
  const token = seller.body.accessToken;
  assert.equal(seller.body.user.emailVerified, true);
  assert.equal(seller.body.user.phoneVerified, false);

  assert.deepEqual(missingFields(await profileAs(token)), ["phone"]);
  await verifyPhoneWithOtp(token, "+919811111112");
  assert.equal((await profileAs(token)).status, 201);
});

test("a phone seller skips phone verification but must add and verify an email", async () => {
  const phone = "+919811111113";
  await api("POST", "/auth/otp/send", { body: { channel: "phone", target: phone, purpose: "login" } });
  const seller = await api("POST", "/auth/otp/login", {
    body: { channel: "phone", target: phone, code: await codeFor(phone), name: "Ravi", termsAccepted: true, role: "seller" },
  });
  const token = seller.body.accessToken;

  assert.deepEqual(missingFields(await profileAs(token)), ["email"]);

  const email = "ravi@example.com";
  assert.equal((await api("POST", "/auth/email/send-verification", { token, body: { email } })).status, 200);
  const code = await codeFor(email);
  const wrong = await api("POST", "/auth/email/verify", { token, body: { email, code: wrongCode(code) } });
  assert.equal(wrong.status, 400);

  const added = await api("POST", "/auth/email/verify", { token, body: { email, code } });
  assert.equal(added.body.user.email, email);
  assert.equal(added.body.user.emailVerified, true);
  assert.equal((await profileAs(token)).status, 201);
});

test("a logged-in user can't take someone's email or swap to another with these endpoints", async () => {
  const send = (token, email) => api("POST", "/auth/email/send-verification", { token, body: { email } });
  assert.equal((await send(undefined, "a@example.com")).status, 401);

  await signup({ email: "taken@example.com" });
  const phone = "+919811111114";
  await api("POST", "/auth/otp/send", { body: { channel: "phone", target: phone, purpose: "login" } });
  const phoneUser = await api("POST", "/auth/otp/login", {
    body: { channel: "phone", target: phone, code: await codeFor(phone), name: "Ravi", termsAccepted: true },
  });
  assert.equal((await send(phoneUser.body.accessToken, "taken@example.com")).status, 409);

  const owner = await signup({ email: "owner@example.com" });
  const other = await send(owner.body.accessToken, "other@example.com");
  assert.equal(other.body.code, "EMAIL_ALREADY_SET");
  const verify = await api("POST", "/auth/email/verify", {
    token: owner.body.accessToken,
    body: { email: "other@example.com", code: "123456" },
  });
  assert.equal(verify.body.code, "EMAIL_ALREADY_SET");

  await db.query("UPDATE users SET email_verified_at = NOW() WHERE email = 'owner@example.com'");
  const again = await send(owner.body.accessToken, "owner@example.com");
  assert.equal(again.body.code, "EMAIL_ALREADY_VERIFIED");
});

test("a logged-in user can verify their own email through the account endpoints", async () => {
  const { body } = await signup();
  await codeFor("asha@example.com");
  await db.query("UPDATE otp_codes SET created_at = NOW() - INTERVAL '2 minutes'");
  const token = body.accessToken;
  const email = "asha@example.com";
  assert.equal((await api("POST", "/auth/email/send-verification", { token, body: { email } })).status, 200);
  const res = await api("POST", "/auth/email/verify", { token, body: { email, code: await codeFor(email) } });
  assert.equal(res.body.user.emailVerified, true);
});

test("customers don't have to verify anything", async () => {
  const customer = await signup();
  assert.equal(customer.body.user.emailVerified, false);
  assert.equal((await api("GET", "/auth/me", { token: customer.body.accessToken })).status, 200);
  assert.equal((await profileAs(customer.body.accessToken)).status, 403);
  assert.equal((await profileAs(customer.body.accessToken)).body.code, "FORBIDDEN");
});

async function pendingProfile(email = "seller@example.com", slug = "rk-electronics") {
  const seller = await signup({ email, role: "seller" });
  await markContactsVerified(seller.body.user.id);
  const res = await api("POST", "/seller/profile", {
    token: seller.body.accessToken,
    body: { ...storeBody, storeSlug: slug },
  });
  return { sellerToken: seller.body.accessToken, id: res.body.profile.id };
}

const decide = (token, id, body) => api("PATCH", `/admin/sellers/${id}/verification`, { token, body });

test("an admin approves a seller, recording who and when", async () => {
  const token = await makeAdmin();
  const { id } = await pendingProfile();
  const admin = await api("GET", "/auth/me", { token });

  const res = await decide(token, id, { status: "approved" });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.verificationStatus, "approved");
  assert.equal(res.body.profile.verifiedBy, admin.body.user.id);
  assert.ok(res.body.profile.verifiedAt);
});

test("rejecting needs a reason, and a rejected seller can later be approved", async () => {
  const token = await makeAdmin();
  const { id } = await pendingProfile();

  assert.equal((await decide(token, id, { status: "rejected" })).status, 400);
  assert.equal((await decide(token, id, { status: "rejected", reason: "   " })).status, 400);

  const rejected = await decide(token, id, { status: "rejected", reason: "Missing GSTIN" });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.profile.rejectionReason, "Missing GSTIN");

  const approved = await decide(token, id, { status: "approved" });
  assert.equal(approved.body.profile.verificationStatus, "approved");
  assert.equal(approved.body.profile.rejectionReason, null);
});

test("an approved seller can't be reviewed again, and unsupported statuses are refused", async () => {
  const token = await makeAdmin();
  const { id } = await pendingProfile();
  assert.equal((await decide(token, id, { status: "suspended" })).status, 400);

  await decide(token, id, { status: "approved" });
  const again = await decide(token, id, { status: "rejected", reason: "Oops" });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "INVALID_STATUS_CHANGE");
});

test("reviewing a missing or badly formed profile id gives a 404 or 400", async () => {
  const token = await makeAdmin();
  const missing = "01a1a678-51f8-7872-8d63-9863d5ebdfad";
  assert.equal((await decide(token, missing, { status: "approved" })).status, 404);
  assert.equal((await decide(token, "not-a-uuid", { status: "approved" })).status, 400);
});

test("only admins can list or review sellers, so sellers can't approve themselves", async () => {
  const { id, sellerToken } = await pendingProfile();
  assert.equal((await decide(undefined, id, { status: "approved" })).status, 401);
  assert.equal((await decide(sellerToken, id, { status: "approved" })).status, 403);
  assert.equal((await api("GET", "/admin/sellers")).status, 401);
  assert.equal((await api("GET", "/admin/sellers", { token: sellerToken })).status, 403);
});

test("admins list sellers by status, oldest first, defaulting to pending", async () => {
  const token = await makeAdmin();
  const first = await pendingProfile("one@example.com", "store-one");
  const second = await pendingProfile("two@example.com", "store-two");
  const third = await pendingProfile("three@example.com", "store-three");
  await decide(token, third.id, { status: "approved" });

  const pending = await api("GET", "/admin/sellers", { token });
  assert.deepEqual(pending.body.profiles.map((p) => p.id), [first.id, second.id]);

  const approved = await api("GET", "/admin/sellers?status=approved", { token });
  assert.deepEqual(approved.body.profiles.map((p) => p.id), [third.id]);

  assert.equal((await api("GET", "/admin/sellers?status=nope", { token })).status, 400);
});

const failLogin = () =>
  api("POST", "/auth/login", { body: { email: "nobody@example.com", password: "wrong-password" } });

test("the 31st failed attempt is limited, with a Retry-After and the usual error shape", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await failLogin()).status, 401);
  const res = await failLogin();
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.ok(Number(res.headers.get("retry-after")) > 0);
});

test("failures on any login or code endpoint share one limit", async () => {
  for (let i = 0; i < 15; i++) await failLogin();
  const otp = { channel: "email", target: "nobody@example.com", code: "123456" };
  for (let i = 0; i < 15; i++) {
    assert.equal((await api("POST", "/auth/otp/login", { body: otp })).status, 400);
  }
  assert.equal((await api("POST", "/auth/otp/login", { body: otp })).status, 429);
  assert.equal((await failLogin()).status, 429);
  assert.equal((await api("POST", "/auth/google", { body: { idToken: "t" } })).status, 429);
});

test("successful logins don't use up the failed-attempt limit", async () => {
  await signup();
  const login = () => api("POST", "/auth/login", { body: { email: "asha@example.com", password: PASSWORD } });
  for (let i = 0; i < 35; i++) assert.equal((await login()).status, 200);
});

test("a client can't send more than 20 codes an hour, even to different numbers", async () => {
  const send = (i) =>
    api("POST", "/auth/otp/send", {
      body: { channel: "phone", target: `+9190000${String(i).padStart(5, "0")}`, purpose: "login" },
    });
  for (let i = 0; i < 20; i++) assert.equal((await send(i)).status, 200);
  const blocked = await send(20);
  assert.equal(blocked.status, 429);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM otp_codes");
  assert.equal(rows[0].n, 20);
});

test("OTP sends to accounts and to unknown targets count the same, so the limit reveals nothing", async () => {
  for (let i = 0; i < 20; i++) {
    const body = { channel: "email", target: `ghost${i}@example.com`, purpose: "login" };
    assert.equal((await api("POST", "/auth/otp/send", { body })).status, 200);
  }
  const body = { channel: "email", target: "ghost20@example.com", purpose: "login" };
  assert.equal((await api("POST", "/auth/otp/send", { body })).status, 429);
});

test("invalid requests count toward the send limit", async () => {
  const body = { channel: "phone", target: "bad" };
  for (let i = 0; i < 20; i++) assert.equal((await api("POST", "/auth/otp/send", { body })).status, 400);
  assert.equal((await api("POST", "/auth/otp/send", { body })).status, 429);
});

test("adding a phone shares the send limit, so logged-in users can't send unlimited SMS", async () => {
  const { body } = await signup();
  const send = (i) =>
    api("POST", "/auth/phone/send-verification", {
      token: body.accessToken,
      body: { phone: `+9190000${String(i).padStart(5, "0")}` },
    });
  for (let i = 0; i < 20; i++) assert.equal((await send(i)).status, 200);
  assert.equal((await send(20)).status, 429);
});

test("the 21st signup in an hour is limited", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await signup({ email: `u${i}@example.com` })).status, 201);
  assert.equal((await signup({ email: "u20@example.com" })).status, 429);
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users");
  assert.equal(rows[0].n, 20);
});

test("all auth requests share an overall limit, but health checks aren't limited", async () => {
  for (let i = 0; i < 300; i++) assert.equal((await api("POST", "/auth/logout")).status, 204);
  assert.equal((await api("POST", "/auth/logout")).status, 429);
  assert.equal((await api("GET", "/auth/me")).status, 429);
  assert.equal((await api("GET", "/health")).status, 200);
});

test("behind a proxy each client IP has its own limit, and a faked header can't get around it", async (t) => {
  app.set("trust proxy", 1);
  t.after(() => {
    app.set("trust proxy", 0);
    for (const limiter of Object.values(limiters)) {
      limiter.resetKey("203.0.113.1");
      limiter.resetKey("203.0.113.2");
    }
  });
  const fromIp = (forwardedFor) =>
    fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedFor },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    });

  for (let i = 0; i < 30; i++) await fromIp("203.0.113.1");
  assert.equal((await fromIp("203.0.113.1")).status, 429);

  // A proxy appends the real IP last, so a client-supplied value in front of it is ignored.
  assert.equal((await fromIp("198.51.100.9, 203.0.113.1")).status, 429);
  assert.equal((await fromIp("203.0.113.2")).status, 401);
});

test("the frontend can read Retry-After, and CORS preflights aren't limited", async () => {
  for (let i = 0; i < 31; i++) await failLogin();
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(res.status, 204);
  const limited = await failLogin();
  assert.match(limited.headers.get("access-control-expose-headers"), /Retry-After/);
});

async function approvedSeller(email = "seller@example.com", slug = "rk-electronics") {
  const token = await makeAdmin(`admin-${slug}@example.com`);
  const { id, sellerToken } = await pendingProfile(email, slug);
  await decide(token, id, { status: "approved" });
  return { adminToken: token, id, sellerToken };
}

const patchProfile = (token, body) => api("PATCH", "/seller/profile", { token, body });
const GSTIN = "22AAAAA0000A1Z5";

test("a seller can read their profile, status and rejection reason", async () => {
  const seller = await signup({ email: "seller@example.com", role: "seller" });
  const token = seller.body.accessToken;
  const none = await api("GET", "/seller/profile", { token });
  assert.equal(none.status, 404);
  assert.equal(none.body.code, "NOT_FOUND");

  await markContactsVerified(seller.body.user.id);
  const { body } = await profileAs(token);
  const admin = await makeAdmin();
  await decide(admin, body.profile.id, { status: "rejected", reason: "Missing GSTIN" });

  const res = await api("GET", "/seller/profile", { token });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.verificationStatus, "rejected");
  assert.equal(res.body.profile.rejectionReason, "Missing GSTIN");
});

test("only sellers can read or edit a seller profile", async () => {
  const customer = await signup();
  assert.equal((await api("GET", "/seller/profile")).status, 401);
  assert.equal((await api("GET", "/seller/profile", { token: customer.body.accessToken })).status, 403);
  assert.equal((await patchProfile(undefined, { storeName: "X" })).status, 401);
  assert.equal((await patchProfile(customer.body.accessToken, { storeName: "X" })).status, 403);
});

test("editing the storefront keeps an approved seller approved, and null clears a field", async () => {
  const { sellerToken } = await approvedSeller();
  const res = await patchProfile(sellerToken, { storeName: "New Name", description: "Hello" });
  assert.equal(res.status, 200);
  assert.equal(res.body.profile.storeName, "New Name");
  assert.equal(res.body.profile.description, "Hello");
  assert.equal(res.body.profile.verificationStatus, "approved");

  const cleared = await patchProfile(sellerToken, { description: null });
  assert.equal(cleared.body.profile.description, null);
  assert.equal(cleared.body.profile.storeName, "New Name");
});

test("a seller can't edit admin-only fields or send nothing, or clear required fields", async () => {
  const { sellerToken } = await pendingProfile();
  const res = await patchProfile(sellerToken, {
    storeName: "Name",
    verificationStatus: "approved",
    commissionRate: 0,
    verifiedBy: "someone",
  });
  assert.equal(res.body.profile.verificationStatus, "pending");
  assert.equal(res.body.profile.commissionRate, "10.00");

  assert.equal((await patchProfile(sellerToken, {})).status, 400);
  assert.equal((await patchProfile(sellerToken, { verificationStatus: "approved" })).status, 400);
  assert.equal((await patchProfile(sellerToken, { storeName: null })).status, 400);
  assert.equal((await patchProfile(sellerToken, { legalBusinessName: null })).status, 400);
});

test("GSTIN is optional, format-checked on create and edit, and stored uppercase", async () => {
  const seller = await signup({ email: "seller@example.com", role: "seller" });
  const token = seller.body.accessToken;
  await markContactsVerified(seller.body.user.id);

  const bad = await api("POST", "/seller/profile", { token, body: { ...storeBody, taxId: "ABC123" } });
  assert.equal(bad.status, 400);
  const created = await api("POST", "/seller/profile", { token, body: { ...storeBody, taxId: GSTIN.toLowerCase() } });
  assert.equal(created.body.profile.taxId, GSTIN);

  assert.equal((await patchProfile(token, { taxId: "22AAAAA0000A1Z" })).status, 400);
  assert.equal((await patchProfile(token, { taxId: null })).body.profile.taxId, null);
});

test("changing legal details on an approved profile sends it back for review", async () => {
  for (const [i, change] of [{ legalBusinessName: "Other Ltd" }, { businessType: "company" }, { taxId: GSTIN }].entries()) {
    const { sellerToken, adminToken, id } = await approvedSeller(`s${i}@example.com`, `store-${i}`);
    const res = await patchProfile(sellerToken, change);
    assert.equal(res.body.profile.verificationStatus, "pending", Object.keys(change)[0]);

    const listed = await api("GET", "/admin/sellers", { token: adminToken });
    const row = listed.body.profiles.find((p) => p.id === id);
    assert.equal(row.verifiedAt, null);
    assert.equal(row.verifiedBy, null);
  }
});

test("resending the same legal details doesn't trigger a review", async () => {
  const { sellerToken } = await approvedSeller();
  const res = await patchProfile(sellerToken, { legalBusinessName: storeBody.legalBusinessName, businessType: "individual" });
  assert.equal(res.body.profile.verificationStatus, "approved");
});

test("editing a rejected profile returns it to pending and clears the reason", async () => {
  const token = await makeAdmin();
  const { id, sellerToken } = await pendingProfile();
  await decide(token, id, { status: "rejected", reason: "Blurry logo" });

  const res = await patchProfile(sellerToken, { description: "Fixed" });
  assert.equal(res.body.profile.verificationStatus, "pending");
  assert.equal(res.body.profile.rejectionReason, null);
  const listed = await api("GET", "/admin/sellers", { token });
  assert.ok(listed.body.profiles.some((p) => p.id === id));
});

test("a suspended profile can't be edited", async () => {
  const { sellerToken } = await approvedSeller();
  await db.query("UPDATE seller_profiles SET verification_status = 'suspended'");
  const res = await patchProfile(sellerToken, { description: "Hi" });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "PROFILE_SUSPENDED");
});

test("editing refuses a taken store URL, someone else's address and a missing profile", async () => {
  const one = await pendingProfile("one@example.com", "store-one");
  const two = await pendingProfile("two@example.com", "store-two");
  assert.equal((await patchProfile(two.sellerToken, { storeSlug: "store-one" })).status, 409);

  const owner = await api("GET", "/auth/me", { token: one.sellerToken });
  const { rows } = await db.query(
    `INSERT INTO addresses (user_id, full_name, phone, address_line1, city, state, postal_code, country_code)
     VALUES ($1, 'A', '+919876543213', 'L1', 'C', 'S', '1', 'IN') RETURNING id`,
    [owner.body.user.id]
  );
  const res = await patchProfile(two.sellerToken, { pickupAddressId: rows[0].id });
  assert.equal(res.body.code, "INVALID_PICKUP_ADDRESS");
  assert.equal((await patchProfile(one.sellerToken, { pickupAddressId: rows[0].id })).status, 200);

  const noProfile = await signup({ email: "new@example.com", role: "seller" });
  assert.equal((await patchProfile(noProfile.body.accessToken, { storeName: "X" })).status, 404);
});

test("CORS only allows the frontend origin, with credentials", async () => {
  const res = await api("GET", "/health");
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:3000");
  assert.equal(res.headers.get("access-control-allow-credentials"), "true");
});

test("malformed JSON is a 400, not a 500", async () => {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad",
  });
  assert.equal(res.status, 400);
});

test("the Resend driver sends the documented request and reports failures", async (t) => {
  const env = require("../src/config/env");
  t.mock.property(env, "RESEND_API_KEY", "re_test");
  t.mock.property(env, "EMAIL_FROM", "Shop <no-reply@example.com>");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response('{"id":"1"}', { status: 200 }));

  const resend = require("../src/services/email/resend");
  await resend.send({ to: "a@example.com", subject: "S", text: "T" });
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.headers.Authorization, "Bearer re_test");
  assert.deepEqual(JSON.parse(init.body), { from: env.EMAIL_FROM, to: "a@example.com", subject: "S", text: "T" });

  fetchMock.mock.mockImplementation(async () => new Response("nope", { status: 403 }));
  await assert.rejects(resend.send({ to: "a@example.com", subject: "S", text: "T" }), /403/);
});

test("the Fast2SMS driver sends a 10-digit number, refuses non-Indian numbers and reports failures", async (t) => {
  const env = require("../src/config/env");
  t.mock.property(env, "FAST2SMS_API_KEY", "f2s_test");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response('{"return":true}', { status: 200 }));

  const fast2sms = require("../src/services/sms/fast2sms");
  await fast2sms.sendOtp("+919876543210", "123456");
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.equal(url, "https://www.fast2sms.com/dev/bulkV2");
  assert.equal(init.headers.authorization, "f2s_test");
  assert.deepEqual(JSON.parse(init.body), { route: "otp", variables_values: "123456", numbers: "9876543210" });

  await assert.rejects(fast2sms.sendOtp("+14155550100", "123456"), /Indian/);
  fetchMock.mock.mockImplementation(async () => new Response('{"return":false}', { status: 200 }));
  await assert.rejects(fast2sms.sendOtp("+919876543210", "123456"), /Fast2SMS/);
});
