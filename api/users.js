// GET    /api/users         -> list all users (superadmin only)
// POST   /api/users         -> create user { username, password, role }
// PATCH  /api/users/:name   -> update role or password (superadmin, or own password)
// DELETE /api/users/:name   -> delete user (superadmin only)
// POST   /api/users/me/password -> change own password { currentPassword, newPassword }
import { guard, readUsers, createUser, updateUser, deleteUser, authenticate } from "./_lib.js";

export default async function handler(req, res) {
  const session = guard(req, res);
  if (!session) return;
  res.setHeader("Cache-Control", "no-store");

  // Vercel maps this file to /api/users only — nested paths 404 unless routed,
  // so vercel.json rewrites /api/users/<path> to /api/users?path=<path>.
  // Prefer that param, and fall back to parsing req.url so the handler still
  // works if it is ever called with the real path (local dev, direct invoke).
  const fromQuery = req.query?.path;
  const rawPath = Array.isArray(fromQuery) ? fromQuery.join("/") : fromQuery || "";
  const segments = rawPath
    ? String(rawPath).split("/").filter(Boolean)
    : req.url.split("?")[0].split("/").filter(Boolean).slice(2);
  const targetUser = segments[0] ? decodeURIComponent(segments[0]) : null;
  const subResource = segments[1] || null;

  // Any logged-in user can change their own password
  if (req.method === "POST" && targetUser === "me" && subResource === "password") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const { currentPassword, newPassword } = body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "current_and_new_password_required" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "password_too_short", detail: "Minimum 6 characters." });
    }
    // Verify current password
    const check = await authenticate(session.username, currentPassword);
    if (!check.ok) {
      return res.status(401).json({ error: "wrong_current_password" });
    }
    // Superadmin password is set via env var — can't be changed here
    if (session.role === "superadmin") {
      return res.status(400).json({ error: "superadmin_use_env", detail: "Change the super admin password via Vercel environment variables." });
    }
    const result = await updateUser(session.username, { password: newPassword });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(200).json({ ok: true });
  }

  // Everything below is superadmin only
  if (session.role !== "superadmin") {
    return res.status(403).json({ error: "forbidden", detail: "Only the super admin can manage users." });
  }

  if (req.method === "GET") {
    const users = await readUsers();
    return res.status(200).json(users.map(u => ({ username: u.username, role: u.role })));
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const result = await createUser(body.username, body.password, body.role);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(201).json({ ok: true });
  }

  if (req.method === "PATCH") {
    if (!targetUser) return res.status(400).json({ error: "username required in URL" });
    // The super admin isn't a Redis user, so there is nothing here to edit —
    // say so plainly instead of returning a confusing "not_found".
    const superAdmin = (process.env.SUPER_ADMIN_USERNAME || "israa").toLowerCase();
    if (targetUser.trim().toLowerCase() === superAdmin) {
      return res.status(400).json({
        error: "superadmin_use_env",
        detail: "The super admin's username and password are Vercel environment variables, not stored users.",
      });
    }
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const result = await updateUser(targetUser, body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(200).json({ ok: true, username: result.username });
  }

  if (req.method === "DELETE") {
    if (!targetUser) return res.status(400).json({ error: "username required in URL" });
    const result = await deleteUser(targetUser);
    if (!result.ok) return res.status(404).json({ error: result.error });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
