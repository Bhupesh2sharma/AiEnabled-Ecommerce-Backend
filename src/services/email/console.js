// Development email driver: prints the message in the server terminal instead of sending it.

async function send({ to, subject, text }) {
  console.log(`[email:console] to=${to} subject="${subject}"\n${text}`);
}

module.exports = { send };
