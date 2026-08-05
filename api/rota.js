// GET  /api/rota  -> { version, entries, role, username }
// PUT  /api/rota  -> save entries (admin/superadmin only)
//   On write, stamps ONLY the entries that actually changed with updatedBy +
//   updatedAt. The dashboard PUTs the whole array on every save, so stamping
//   everything would rewrite every row's "last updated" note on each edit.
import { guard, readRota, writeRota } from "./_lib.js";

// Compare two entries ignoring the audit stamp itself, so re-sending an
// untouched entry is not mistaken for an edit.
const STAMP_FIELDS = new Set(["updatedBy", "updatedAt"]);
function fingerprint(entry) {
  const keys = Object.keys(entry || {}).filter((k) => !STAMP_FIELDS.has(k)).sort();
  return JSON.stringify(keys.map((k) => [k, entry[k]]));
}

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

      // Read the stored rota once — needed both for the delete check and to
      // work out which entries the caller actually changed.
      const current = await readRota();

      // Only superadmin can delete entries (i.e. send fewer entries than currently stored)
      if (session.role !== "superadmin" && expected !== null
          && entries.length < current.entries.length) {
        return res.status(403).json({ error: "forbidden", detail: "Only the super admin can delete rota entries." });
      }

      // Stamp only what changed. An untouched entry keeps the stamp it already
      // had, so "who updated this and when" stays true per row.
      const now = new Date().toISOString();
      const previous = new Map(current.entries.map((e) => [e.id, e]));
      const stamped = entries.map((e) => {
        const prev = e.id ? previous.get(e.id) : null;
        if (prev && fingerprint(prev) === fingerprint(e)) {
          return { ...e, updatedBy: prev.updatedBy, updatedAt: prev.updatedAt };
        }
        return { ...e, updatedBy: session.username, updatedAt: now };
      });

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
