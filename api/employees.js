// GET    /api/employees              -> { employees, accounts, role, username }
//   accounts (login usernames) only for admins, to link an employee to a login
// POST   /api/employees { name, username?, position?, active? }   admin / superadmin
// PUT    /api/employees { id, name, username?, position?, active? } admin / superadmin
// DELETE /api/employees?id=<id>      superadmin only — also deletes their leave
//
// Employees live in their own Redis key (rota:employees); this never touches
// the rota entries, their version counter or the user accounts.
import { randomBytes } from "node:crypto";
import { guard, readUsers, readEmployees, writeEmployee, deleteEmployee } from "./_lib.js";

const norm = (s) => String(s || "").trim().toLowerCase();
const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);

async function accountNames() {
  const superAdmin = norm(process.env.SUPER_ADMIN_USERNAME || "israa");
  const users = await readUsers();
  return [superAdmin, ...users.map((u) => norm(u.username))].filter(Boolean);
}

export default async function handler(req, res) {
  const session = guard(req, res);
  if (!session) return;
  res.setHeader("Cache-Control", "no-store");
  const isAdmin = session.role === "admin" || session.role === "superadmin";

  try {
    if (req.method === "GET") {
      const employees = await readEmployees();
      return res.status(200).json({
        employees,
        accounts: isAdmin ? await accountNames() : [],
        role: session.role, username: session.username,
      });
    }

    if (req.method === "DELETE") {
      if (session.role !== "superadmin") {
        return res.status(403).json({ error: "forbidden", detail: "Only the super admin can delete employees." });
      }
      const id = String(req.query?.id || "");
      const employees = await readEmployees();
      if (!employees.some((e) => e.id === id)) return res.status(404).json({ error: "not_found" });
      await deleteEmployee(id);
      return res.status(200).json({ ok: true });
    }

    if (req.method !== "POST" && req.method !== "PUT") return res.status(405).json({ error: "method not allowed" });
    if (!isAdmin) return res.status(403).json({ error: "forbidden", detail: "Only admins can add or edit employees." });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const name = clean(body.name, 60);
    const username = norm(body.username);
    const position = clean(body.position, 60);
    const active = body.active !== false;
    if (name.length < 2) return res.status(400).json({ error: "name_required" });

    const employees = await readEmployees();
    const existing = req.method === "PUT" ? employees.find((e) => e.id === body.id) : null;
    if (req.method === "PUT" && !existing) return res.status(404).json({ error: "not_found" });

    const others = employees.filter((e) => e.id !== existing?.id);
    if (others.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: "name_taken" });
    }
    if (username) {
      if (!(await accountNames()).includes(username)) return res.status(400).json({ error: "unknown_login" });
      if (others.some((e) => e.username === username)) return res.status(400).json({ error: "login_taken" });
    }

    const now = new Date().toISOString();
    const emp = {
      id: existing?.id || randomBytes(6).toString("hex"),
      name, username, position, active,
      createdAt: existing?.createdAt || now,
      updatedBy: session.username, updatedAt: now,
    };
    await writeEmployee(emp);
    return res.status(200).json({ ok: true, employee: emp });
  } catch (e) {
    const message = String(e?.message || e);
    if (message === "STORAGE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "not_configured", detail: "No Redis store connected." });
    }
    return res.status(500).json({ error: message });
  }
}
