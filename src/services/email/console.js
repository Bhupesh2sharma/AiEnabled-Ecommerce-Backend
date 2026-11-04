async function send({ to, subject, text }) {
  console.log(`[email:console] to=${to} subject="${subject}"\n${text}`);
}

module.exports = { send };
