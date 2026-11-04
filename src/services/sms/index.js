const env = require("../../config/env");

const driver = require(`./${env.SMS_DRIVER}`);

module.exports = { sendOtpSms: (phone, code) => driver.sendOtp(phone, code) };
