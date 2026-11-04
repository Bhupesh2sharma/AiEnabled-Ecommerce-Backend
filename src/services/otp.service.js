const db = require("../config/db");
const OtpModel = require("../models/otp.model");
const ApiError = require("../utils/ApiError");
const { generateOtp, hashOtp, otpMatches } = require("../utils/otp");
const { sendOtpEmail } = require("./email");
const { sendOtpSms } = require("./sms");

const EXPIRES_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_SENDS_PER_HOUR = 5;

const invalidCode = () =>
  new ApiError(400, "Invalid or expired code", { code: "INVALID_OTP" });

function deliver({ channel, target, purpose }, code) {
  return channel === "email" ? sendOtpEmail(target, code, purpose) : sendOtpSms(target, code);
}

// Creates a code, replacing any earlier one, and sends it.
async function issueOtp({ channel, target, purpose }) {
  const code = generateOtp();
  const codeHash = hashOtp({ channel, target, purpose, code });

  const otp = await db.transaction(async (client) => {
    // Serialises sends per target, so parallel requests can't slip past the limits.
    await OtpModel.lockTarget(target, client);

    const { seconds_since_last: sinceLast, sent_last_hour: sentLastHour } =
      await OtpModel.getSendStats({ channel, target, purpose }, client);
    if (sinceLast !== null && sinceLast < RESEND_COOLDOWN_SECONDS) {
      throw new ApiError(429, "Please wait before requesting another code", { code: "OTP_COOLDOWN" });
    }
    if (sentLastHour >= MAX_SENDS_PER_HOUR) {
      throw new ApiError(429, "Too many codes requested. Try again later", { code: "OTP_LIMIT" });
    }

    await OtpModel.purgeOld({ channel, target, purpose }, client);
    await OtpModel.consumeActive({ channel, target, purpose }, client);
    return OtpModel.create({ channel, target, purpose, codeHash, expiresMinutes: EXPIRES_MINUTES }, client);
  });

  try {
    await deliver({ channel, target, purpose }, code);
  } catch (err) {
    await OtpModel.remove(otp.id); // nothing was delivered, so let the user retry straight away
    console.error(`Failed to send ${purpose} OTP via ${channel}:`, err);
    throw new ApiError(502, "Could not send the code. Try again shortly", { code: "OTP_DELIVERY_FAILED" });
  }
}

// For public endpoints: the response must not depend on whether the account exists,
// so neither provider latency nor limit errors can reach the client.
function issueOtpInBackground(fields) {
  issueOtp(fields).catch((err) => {
    if (err.status !== 429 && err.status !== 502) console.error("Failed to issue OTP:", err);
  });
}

// Checks a code without using it up. The attempt is counted before comparing,
// so parallel guesses can't get past the limit.
async function checkOtp({ channel, target, purpose, code }) {
  const otp = await OtpModel.findActive({ channel, target, purpose });
  if (!otp) throw invalidCode();
  if (!(await OtpModel.countAttempt(otp.id, MAX_ATTEMPTS))) throw invalidCode();
  if (!otpMatches({ channel, target, purpose, code }, otp.code_hash)) throw invalidCode();
  return otp;
}

// Marks a checked code as used. Fails if a parallel request used it first.
async function consumeOtp(otp) {
  if (!(await OtpModel.consume(otp.id))) throw invalidCode();
}

async function verifyOtp(fields) {
  await consumeOtp(await checkOtp(fields));
}

module.exports = {
  RESEND_COOLDOWN_SECONDS,
  issueOtp,
  issueOtpInBackground,
  checkOtp,
  consumeOtp,
  verifyOtp,
  invalidCode,
};
