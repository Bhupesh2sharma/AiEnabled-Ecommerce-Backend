// Development SMS driver: prints the code in the server terminal instead of sending it.

async function sendOtp(phone, code) {
  console.log(`[sms:console] to=${phone}\nYour OTP: ${code}`);
}

module.exports = { sendOtp };
