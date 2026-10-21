import { createClient } from "@supabase/supabase-js";
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD } =
  process.env;
if (
  !SUPABASE_URL ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !ADMIN_EMAIL ||
  !ADMIN_PASSWORD ||
  ADMIN_PASSWORD.length < 6 ||
  ADMIN_PASSWORD.length > 128
)
  throw new Error(
    "Configure Supabase and first-admin credentials securely before running bootstrap.",
  );
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const existing = await db
  .from("wg_profiles")
  .select("id")
  .eq("role", "admin")
  .limit(1);
if (existing.error)
  throw new Error("Apply supabase/migrations/001_wetagold.sql first.");
if (existing.data.length)
  throw new Error(
    "An administrator already exists. No account or password was changed.",
  );
const created = await db.auth.admin.createUser({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  email_confirm: true,
});
if (created.error)
  throw new Error(
    "Administrator creation failed. Verify the email and Supabase password requirements.",
  );
const inserted = await db.from("wg_profiles").insert({
  id: created.data.user.id,
  email: ADMIN_EMAIL.trim().toLowerCase(),
  role: "admin",
  must_change_password: true,
});
if (inserted.error) {
  const removed = await db.auth.admin.deleteUser(created.data.user.id);
  throw new Error(
    removed.error
      ? "Administrator profile failed and Auth cleanup failed. Review Auth users in the project dashboard before retrying."
      : "Administrator profile creation failed; the new Auth account was removed.",
  );
}
console.log(
  "The single administrator is ready. Password replacement is required on first login.",
);
