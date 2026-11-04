async function sendOtp(phone, code) {
  console.log(`[sms:console] to=${phone}\nYour OTP: ${code}`);
}

module.exports = { sendOtp };
