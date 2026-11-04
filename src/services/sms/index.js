// Picks the SMS driver from SMS_DRIVER. Add a provider by adding a file with a sendOtp() function
// and listing it in config/env.js.

const env = require("../../config/env");

const driver = require(`./${env.SMS_DRIVER}`);

module.exports = { sendOtpSms: (phone, code) => driver.sendOtp(phone, code) };
