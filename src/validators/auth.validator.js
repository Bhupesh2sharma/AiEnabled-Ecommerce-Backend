// Request body rules for the auth and admin-creation endpoints. Emails are trimmed and lowercased here.

const { z } = require("zod");

const email = z.string().trim().toLowerCase().max(255).pipe(z.email("Enter a valid email address"));
const phone = z.string().trim().regex(/^\+[1-9][0-9]{6,14}$/, "Phone must be in E.164 format, e.g. +919876543210");
const name = z.string().trim().min(1, "Name is required").max(100);
const code = z.string().regex(/^[0-9]{6}$/, "Code must be 6 digits");
// bcrypt only reads the first 72 bytes, so a longer password would be silently cut.
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine((value) => Buffer.byteLength(value) <= 72, "Password must be at most 72 bytes");
const role = z.enum(["customer", "seller"]).default("customer");
const termsAccepted = z.literal(true, { error: "You must accept the terms" });
const marketingOptIn = z.boolean().default(false);

const emailSignup = z.object({ name, email, password, role, termsAccepted, marketingOptIn });

const emailLogin = z.object({ email, password: z.string().min(1, "Password is required") });

const otpSend = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("email"),
    target: email,
    purpose: z.enum(["verify_email", "login", "reset_password"]),
  }),
  z.object({ channel: z.literal("phone"), target: phone, purpose: z.literal("login") }),
]);

const verifyEmail = z.object({ email, code });

// name and termsAccepted are only needed when a phone OTP login creates the account.
const signupDetails = {
  name: name.optional(),
  role,
  termsAccepted: termsAccepted.optional(),
  marketingOptIn,
};
const otpLogin = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("email"), target: email, code }),
  z.object({ channel: z.literal("phone"), target: phone, code, ...signupDetails }),
]);

const resetPassword = z.object({ email, code, newPassword: password });

const emailSendVerification = z.object({ email });
const emailVerify = z.object({ email, code });
const phoneSendVerification = z.object({ phone });
const phoneVerify = z.object({ phone, code });

const googleLogin = z.object({
  idToken: z.string().min(1, "idToken is required"),
  role,
  termsAccepted: termsAccepted.optional(),
  marketingOptIn,
});

const createAdmin = z.object({ name, email, password });

module.exports = {
  emailSignup,
  emailLogin,
  otpSend,
  verifyEmail,
  otpLogin,
  resetPassword,
  emailSendVerification,
  emailVerify,
  phoneSendVerification,
  phoneVerify,
  googleLogin,
  createAdmin,
};
