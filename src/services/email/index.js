// Picks the email driver from EMAIL_DRIVER. Add a provider by adding a file with a send() function
// and listing it in config/env.js.

const env = require("../../config/env");

const driver = require(`./${env.EMAIL_DRIVER}`);

const SUBJECTS = {
  verify_email: "Verify your email",
  login: "Your login code",
  reset_password: "Reset your password",
};

function sendOtpEmail(to, code, purpose) {
  return driver.send({
    to,
    subject: SUBJECTS[purpose],
    text: `Your code is ${code}. It expires in 5 minutes. If you didn't request it, you can ignore this email.`,
  });
}

module.exports = { sendOtpEmail };
