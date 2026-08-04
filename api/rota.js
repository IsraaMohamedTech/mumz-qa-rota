// GET  /api/rota  -> { version, entries, role, username }
// PUT  /api/rota  -> save entries (admin/superadmin only)
//   On write, stamps each changed entry with updatedBy + updatedAt.
import { guard, readRota, writeRota } from "./_lib.js";

export default async function handler(req, res) {
  const session = guard(req, res);
  if (!session) return;
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const { version, entries } = await readRota();
      return res.status(200).json({ version, entries, role: session.role, username: session.username });
    }

    if (req.method === "PUT" || req.method === "POST") {
      // Viewers cannot write
      if (session.role === "viewer") {
        return res.status(403).json({ error: "forbidden", detail: "Viewers cannot edit the rota." });
      }

      const body    = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;
      const entries = Array.isArray(body) ? body : body?.entries;
      const expected = Array.isArray(body) ? null : body?.version;

      if (!Array.isArray(entries)) {
        return res.status(400).json({ error: "expected a JSON array, or { version, entries }" });
      }

      // Stamp each entry with who saved it and when
      const now = new Date().toISOString();
      const stamped = entries.map(e => ({
        ...e,
        updatedBy: session.username,
        updatedAt: now,
      }));

      const version = await writeRota(stamped, expected === undefined ? null : expected);

      if (version === -1) {
        const current = await readRota();
        return res.status(409).json({
          error:   "conflict",
          detail:  "Someone else saved changes since you loaded the page.",
          version: current.version,
          entries: current.entries,
        });
      }
      return res.status(200).json({ ok: true, count: stamped.length, version });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    const message = String(e?.message || e);
    if (message === "STORAGE_NOT_CONFIGURED") {
      return res.status(503).json({ error: "not_configured", detail: "No Redis store connected." });
    }
    return res.status(500).json({ error: message });
  }
}
