// Production SMS driver. Needs FAST2SMS_API_KEY.

const env = require("../../config/env");

// Uses the OTP route and its pre-approved template "Your OTP: {#var#}". Indian numbers only.
async function sendOtp(phone, code) {
  if (!phone.startsWith("+91")) {
    throw new Error("Fast2SMS only delivers to Indian (+91) numbers");
  }

  const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: { authorization: env.FAST2SMS_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ route: "otp", variables_values: code, numbers: phone.slice(3) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.return) {
    throw new Error(`Fast2SMS responded ${response.status}: ${JSON.stringify(body)}`);
  }
}

module.exports = { sendOtp };
