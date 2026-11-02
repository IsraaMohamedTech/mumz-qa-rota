// GET  /api/leaves -> { from, to, types, employees, cells, username, role }
//   employees: everyone on the Employees tab (inactive ones included, so their
//              past leave still shows in the report)
//   cells:     { "<employee id>|<YYYY-MM-DD>": { t, title?, by, at } }
// POST /api/leaves { employeeId, dates: [...], type, title? }
//   type null/"" clears the days; title is kept only for "other" leave.
//   Anyone signed in (viewers too) can fill the row linked to their own login;
//   admins can fill any row.
import { guard, readLeavesAndEmployees, writeLeaveDays } from "./_lib.js";

export const LEAVE_FROM = "2026-12-01";
export const LEAVE_TO   = "2027-12-31";
const TYPES = ["annual", "sick", "wfh", "other"];
const MAX_DAYS_PER_WRITE = 400;
const MAX_TITLE = 40;

const norm = (s) => String(s || "").trim().toLowerCase();

function validDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(d + "T00:00:00Z");
  return !isNaN(t) && new Date(t).toISOString().slice(0, 10) === d && d >= LEAVE_FROM && d <= LEAVE_TO;
}

export default async function handler(req, res) {
  const session = guard(req, res);
  if (!session) return;
  res.setHeader("Cache-Control", "no-store");
  const isAdmin = session.role === "admin" || session.role === "superadmin";

  try {
    if (req.method === "GET") {
      const { cells, employees } = await readLeavesAndEmployees();
      return res.status(200).json({
        from: LEAVE_FROM, to: LEAVE_TO, types: TYPES,
        employees, cells,
        username: session.username, role: session.role,
      });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    const employeeId = String(body.employeeId || "");
    const type = body.type || null;
    const dates = Array.isArray(body.dates) ? body.dates : [];
    // Only "other" leave carries a title (e.g. "Hajj", "Exam leave")
    const title = type === "other" ? String(body.title || "").replace(/\s+/g, " ").trim() : "";
    if (type !== null && !TYPES.includes(type)) return res.status(400).json({ error: "invalid_type" });
    if (title.length > MAX_TITLE) return res.status(400).json({ error: "title_too_long", detail: `Keep the title under ${MAX_TITLE} characters.` });
    if (!dates.length || dates.length > MAX_DAYS_PER_WRITE || !dates.every(validDate)) {
      return res.status(400).json({ error: "invalid_dates", detail: `Dates must be between ${LEAVE_FROM} and ${LEAVE_TO}.` });
    }

    const { employees } = await readLeavesAndEmployees();
    const emp = employees.find((e) => e.id === employeeId);
    if (!emp) return res.status(400).json({ error: "unknown_employee" });
    if (!isAdmin && !(emp.username && emp.username === norm(session.username))) {
      return res.status(403).json({ error: "forbidden", detail: "You can only fill in your own leave." });
    }

    await writeLeaveDays(employeeId, [...new Set(dates)], type, session.username, title);
    return res.status(200).json({ ok: true, count: dates.length });
  } catch (e) {
    const message = String(e?.message || e);
    if (message === "STORAGE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "not_configured", detail: "No Redis store connected." });
    }
    return res.status(500).json({ error: message });
  }
}
