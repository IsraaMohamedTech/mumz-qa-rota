// GET /api/health -> deployment self-check. Deliberately reveals whether the
// password and store are configured (booleans only) so a bad deploy is easy to
// diagnose without exposing any rota content.
import { isConfigured } from "./_lib.js";

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    passwordConfigured: Boolean(process.env.ROTA_PASSWORD),
    storeConfigured: Boolean(
      (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) &&
        (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
    ),
    ready: isConfigured(),
  });
}
