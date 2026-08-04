// GET  /api/rota  -> { version, entries }
// PUT  /api/rota  -> save. Body is either a bare array (forced write, used by
//                   Import) or { version, entries } for a safe write that is
//                   rejected with 409 if someone else saved first.
import { guard, readRota, writeRota } from "./_lib.js";

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method === "GET") {
      const { version, entries } = await readRota();
      return res.status(200).json({ version, entries });
    }

    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "null") : req.body;

      // A bare array means "overwrite whatever is there" — Import, or an older
      // dashboard that predates versioning.
      const entries = Array.isArray(body) ? body : body?.entries;
      const expected = Array.isArray(body) ? null : body?.version;

      if (!Array.isArray(entries)) {
        return res.status(400).json({ error: "expected a JSON array, or { version, entries }" });
      }

      const version = await writeRota(entries, expected === undefined ? null : expected);

      if (version === -1) {
        const current = await readRota();
        return res.status(409).json({
          error: "conflict",
          detail: "Someone else saved changes since you loaded the page.",
          version: current.version,
          entries: current.entries,
        });
      }
      return res.status(200).json({ ok: true, count: entries.length, version });
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
