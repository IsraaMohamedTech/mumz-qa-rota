// GET    /api/login -> { authed, configured }  (session check, no secrets)
// POST   /api/login -> { password } sets the shared session cookie
// DELETE /api/login -> signs out
import { checkPassword, sessionCookie, clearCookie, isAuthed, isConfigured } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({ authed: isAuthed(req), configured: isConfigured() });
  }

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  if (!process.env.ROTA_PASSWORD) {
    return res.status(503).json({
      error: "not_configured",
      detail: "ROTA_PASSWORD is not set on this deployment.",
    });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (!checkPassword(body.password)) {
    return res.status(401).json({ error: "wrong_password" });
  }

  res.setHeader("Set-Cookie", sessionCookie());
  return res.status(200).json({ ok: true });
}
