// GET    /api/login -> { authed, configured, username, role }
// POST   /api/login -> { username, password } — sets session cookie
// DELETE /api/login -> signs out
import { authenticate, sessionCookie, clearCookie, parseSession, isConfigured } from "./_lib.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const session = parseSession(req);
    return res.status(200).json({
      authed:     session.authed,
      username:   session.authed ? session.username : null,
      role:       session.authed ? session.role : null,
      configured: isConfigured(),
    });
  }

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  if (!isConfigured()) {
    return res.status(503).json({
      error: "not_configured",
      detail: "SUPER_ADMIN_PASSWORD is not set on this deployment.",
    });
  }

  const body   = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const result = await authenticate(body.username, body.password);

  if (!result.ok) {
    return res.status(401).json({ error: "wrong_credentials" });
  }

  res.setHeader("Set-Cookie", sessionCookie(result.username, result.role));
  return res.status(200).json({ ok: true, username: result.username, role: result.role });
}
