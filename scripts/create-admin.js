// Creates the first admin. Later admins are created through POST /api/admin/admins.
//
//   npm run create-admin
//
// Asks for the details, or reads ADMIN_NAME, ADMIN_EMAIL and ADMIN_PASSWORD from the environment.
// The password is never taken as an argument, so it stays out of shell history.

const readline = require("readline/promises");
const { Writable } = require("stream");

async function prompt(question, { hidden = false } = {}) {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  const answer = rl.question(question);
  muted = hidden;
  try {
    return await answer;
  } finally {
    rl.close();
    if (hidden) process.stdout.write("\n");
  }
}

async function main() {
  const { pool } = require("../src/config/db");
  const UserModel = require("../src/models/user.model");
  const { hashPassword } = require("../src/utils/password");
  const { createAdmin } = require("../src/validators/auth.validator");

  try {
    if (await UserModel.adminExists()) {
      throw new Error("An admin already exists. Use POST /api/admin/admins to add another.");
    }

    const parsed = createAdmin.safeParse({
      name: process.env.ADMIN_NAME ?? (await prompt("Name: ")),
      email: process.env.ADMIN_EMAIL ?? (await prompt("Email: ")),
      password: process.env.ADMIN_PASSWORD ?? (await prompt("Password: ", { hidden: true })),
    });
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }

    const { name, email, password } = parsed.data;
    const admin = await UserModel.create({
      name,
      email,
      role: "admin",
      emailVerified: true,
      passwordHash: await hashPassword(password),
    });
    console.log(`Created admin ${admin.email} (${admin.id})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
