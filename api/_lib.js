// Shared helpers for the Mumzworld QA Rota API on Vercel.
//
// Storage is Upstash Redis, reached over its REST API with plain fetch so this
// project keeps zero npm dependencies. Two keys are used:
//   rota:data     JSON array of rota entries
//   rota:version  integer, bumped on every successful write
//
// The version is what makes concurrent editing safe: a client sends the version
// it last read, and the write only lands if that is still current.
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

const DATA_KEY = "rota:data";
const VERSION_KEY = "rota:version";

// The Vercel Marketplace Upstash integration injects the KV_* names; a manual
// Upstash setup uses the UPSTASH_* names. Accept either.
function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

async function redis(command) {
  const cfg = redisConfig();
  if (!cfg) throw new Error("STORAGE_NOT_CONFIGURED");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`redis: ${body.error || res.status}`);
  return body.result;
}

/** Read the rota plus the version it was read at. */
export async function readRota() {
  const cfg = redisConfig();
  if (!cfg) throw new Error("STORAGE_NOT_CONFIGURED");
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["GET", VERSION_KEY], ["GET", DATA_KEY]]),
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) throw new Error(`redis: pipeline ${res.status}`);
  const version = Number(body[0]?.result || 0);
  let entries = [];
  try {
    const parsed = JSON.parse(body[1]?.result ?? "[]");
    if (Array.isArray(parsed)) entries = parsed;
  } catch {
    entries = [];
  }
  return { version, entries };
}

// Compare-and-set in a single round trip. Returns the new version, or -1 when
// the caller's version is stale (someone else saved first).
const CAS = `
local current = redis.call('GET', KEYS[1])
if (current or '0') ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[2], ARGV[2])
return redis.call('INCR', KEYS[1])
`;

/**
 * Write the rota if `expectedVersion` is still current.
 * Pass expectedVersion === null to force the write (used by Import).
 */
export async function writeRota(entries, expectedVersion) {
  const payload = JSON.stringify(entries);
  if (expectedVersion === null) {
    await redis(["SET", DATA_KEY, payload]);
    return Number(await redis(["INCR", VERSION_KEY]));
  }
  const result = Number(
    await redis(["EVAL", CAS, "2", VERSION_KEY, DATA_KEY, String(expectedVersion), payload])
  );
  return result;
}

// ---------------------------------------------------------------------------
// Auth: one shared team password, held in the ROTA_PASSWORD env var.
//
// A Vercel production URL is publicly reachable, and this rota holds staff
// names and schedules, so the API refuses to serve anything until a password
// is configured. Failing closed beats quietly exposing the data.
// ---------------------------------------------------------------------------
const COOKIE = "rota_auth";
const SESSION_DAYS = 30;

function secret() {
  // ROTA_SECRET is preferred; fall back to deriving from the password so a
  // deploy that only sets ROTA_PASSWORD still works.
  return process.env.ROTA_SECRET || `derived:${process.env.ROTA_PASSWORD || ""}`;
}

function sign(expiry) {
  const passwordFingerprint = createHash("sha256")
    .update(process.env.ROTA_PASSWORD || "")
    .digest("hex");
  return createHmac("sha256", secret()).update(`${expiry}:${passwordFingerprint}`).digest("hex");
}

function equal(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isConfigured() {
  return Boolean(process.env.ROTA_PASSWORD) && Boolean(redisConfig());
}

export function checkPassword(candidate) {
  const expected = process.env.ROTA_PASSWORD;
  if (!expected) return false;
  return equal(candidate ?? "", expected);
}

/** Build the Set-Cookie value for a fresh session. */
export function sessionCookie() {
  const expiry = Date.now() + SESSION_DAYS * 86400_000;
  const value = `${expiry}.${sign(expiry)}`;
  const maxAge = SESSION_DAYS * 86400;
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isAuthed(req) {
  const raw = req.headers?.cookie || "";
  const match = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  if (!match) return false;
  const [expiry, signature] = match.slice(COOKIE.length + 1).split(".");
  if (!expiry || !signature) return false;
  if (!Number(expiry) || Number(expiry) < Date.now()) return false;
  return equal(signature, sign(Number(expiry)));
}

/**
 * Gate a handler. Returns true when the request may proceed; otherwise it has
 * already written the response.
 */
export function guard(req, res) {
  if (!process.env.ROTA_PASSWORD) {
    res.status(503).json({
      error: "not_configured",
      detail: "ROTA_PASSWORD is not set on this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy.",
    });
    return false;
  }
  if (!redisConfig()) {
    res.status(503).json({
      error: "not_configured",
      detail: "No Redis store is connected. Add an Upstash Redis store in Vercel → Storage, then redeploy.",
    });
    return false;
  }
  if (!isAuthed(req)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
