// GET    /api/users         -> list all users (superadmin only)
// POST   /api/users         -> create user { username, password, role }
// PATCH  /api/users/:name   -> update role or password
// DELETE /api/users/:name   -> delete user
import { guard, readUsers, createUser, updateUser, deleteUser } from "./_lib.js";

export default async function handler(req, res) {
  const session = guard(req, res);
  if (!session) return;
  res.setHeader("Cache-Control", "no-store");

  // Only superadmin can manage users
  if (session.role !== "superadmin") {
    return res.status(403).json({ error: "forbidden", detail: "Only the super admin can manage users." });
  }

  const urlParts = req.url.split("?")[0].split("/").filter(Boolean);
  // urlParts: ["api", "users"] or ["api", "users", "username"]
  const targetUser = urlParts[2] ? decodeURIComponent(urlParts[2]) : null;

  if (req.method === "GET") {
    const users = await readUsers();
    // Never return password hashes
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
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const result = await updateUser(targetUser, body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.status(200).json({ ok: true });
  }

  if (req.method === "DELETE") {
    if (!targetUser) return res.status(400).json({ error: "username required in URL" });
    const result = await deleteUser(targetUser);
    if (!result.ok) return res.status(404).json({ error: result.error });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "method not allowed" });
}
