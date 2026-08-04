// Shared helpers for the Mumzworld QA Rota API on Vercel.
//
// Storage: Upstash Redis via its REST API (plain fetch, zero npm deps).
// Keys used:
//   rota:data     JSON array of rota entries
//   rota:version  integer, bumped on every successful write
//   rota:users    JSON array of { username, passwordHash, role }
//
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

const DATA_KEY    = "rota:data";
const VERSION_KEY = "rota:version";
const USERS_KEY   = "rota:users";

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------
function redisConfig() {
  const url   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
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

// ---------------------------------------------------------------------------
// Rota data
// ---------------------------------------------------------------------------
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
  } catch { entries = []; }
  return { version, entries };
}

const CAS = `
local current = redis.call('GET', KEYS[1])
if (current or '0') ~= ARGV[1] then return -1 end
redis.call('SET', KEYS[2], ARGV[2])
return redis.call('INCR', KEYS[1])
`;

export async function writeRota(entries, expectedVersion) {
  const payload = JSON.stringify(entries);
  if (expectedVersion === null) {
    await redis(["SET", DATA_KEY, payload]);
    return Number(await redis(["INCR", VERSION_KEY]));
  }
  return Number(
    await redis(["EVAL", CAS, "2", VERSION_KEY, DATA_KEY, String(expectedVersion), payload])
  );
}

// ---------------------------------------------------------------------------
// Password hashing — SHA-256 + salt (no npm deps needed)
// ---------------------------------------------------------------------------
function hashPassword(password, salt) {
  const s = salt || createHash("sha256").update(Math.random().toString()).digest("hex").slice(0, 16);
  const hash = createHash("sha256").update(s + password).digest("hex");
  return `${s}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt] = stored.split(":");
  return stored === hashPassword(password, salt);
}

// ---------------------------------------------------------------------------
// User management (stored in Redis)
// ---------------------------------------------------------------------------

/** Read all users from Redis. Returns [] if none. */
export async function readUsers() {
  const raw = await redis(["GET", USERS_KEY]).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Write users array to Redis. */
async function writeUsers(users) {
  await redis(["SET", USERS_KEY, JSON.stringify(users)]);
}

/** Create a new user. Returns { ok, error }. */
export async function createUser(username, password, role) {
  const users = await readUsers();
  const name = (username || "").trim().toLowerCase();
  if (!name) return { ok: false, error: "username_required" };
  if (!password) return { ok: false, error: "password_required" };
  if (role !== "admin" && role !== "viewer") return { ok: false, error: "invalid_role" };
  if (users.find(u => u.username === name)) return { ok: false, error: "username_taken" };
  // Don't allow creating a user with the super admin's name
  const superAdmin = (process.env.SUPER_ADMIN_USERNAME || "israa").toLowerCase();
  if (name === superAdmin) return { ok: false, error: "username_reserved" };
  users.push({ username: name, passwordHash: hashPassword(password), role });
  await writeUsers(users);
  return { ok: true };
}

/** Update a user's role or password. Returns { ok, error }. */
export async function updateUser(username, updates) {
  const users = await readUsers();
  const name = (username || "").trim().toLowerCase();
  const idx = users.findIndex(u => u.username === name);
  if (idx === -1) return { ok: false, error: "not_found" };
  if (updates.role) {
    if (updates.role !== "admin" && updates.role !== "viewer") return { ok: false, error: "invalid_role" };
    users[idx].role = updates.role;
  }
  if (updates.password) {
    users[idx].passwordHash = hashPassword(updates.password);
  }
  await writeUsers(users);
  return { ok: true };
}

/** Delete a user. Returns { ok, error }. */
export async function deleteUser(username) {
  const users = await readUsers();
  const name = (username || "").trim().toLowerCase();
  const filtered = users.filter(u => u.username !== name);
  if (filtered.length === users.length) return { ok: false, error: "not_found" };
  await writeUsers(filtered);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Auth — session cookies
// ---------------------------------------------------------------------------
const COOKIE      = "rota_auth";
const SESSION_DAYS = 30;

function secret() {
  return process.env.ROTA_SECRET || `derived:${process.env.SUPER_ADMIN_PASSWORD || ""}`;
}

function sign(expiry, username, role) {
  return createHmac("sha256", secret())
    .update(`${expiry}:${username}:${role}`)
    .digest("hex");
}

function equal(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function isConfigured() {
  return Boolean(process.env.SUPER_ADMIN_PASSWORD) && Boolean(redisConfig());
}

/**
 * Authenticate username + password.
 * Checks super admin first (env vars), then Redis users.
 * Returns { ok, username, role } or { ok: false }.
 */
export async function authenticate(username, password) {
  const name = (username || "").trim().toLowerCase();
  if (!name || !password) return { ok: false };

  // Super admin check (always works, even if Redis is empty)
  const superAdmin = (process.env.SUPER_ADMIN_USERNAME || "israa").toLowerCase();
  const superPass  = process.env.SUPER_ADMIN_PASSWORD || "";
  if (name === superAdmin) {
    if (!equal(password, superPass)) return { ok: false };
    return { ok: true, username: name, role: "superadmin" };
  }

  // Redis users
  const users = await readUsers();
  const user = users.find(u => u.username === name);
  if (!user) return { ok: false };
  if (!verifyPassword(password, user.passwordHash)) return { ok: false };
  return { ok: true, username: name, role: user.role };
}

/** Build the Set-Cookie value for a fresh session. */
export function sessionCookie(username, role) {
  const expiry = Date.now() + SESSION_DAYS * 86400_000;
  const sig    = sign(expiry, username, role);
  const value  = `${expiry}.${username}.${role}.${sig}`;
  const maxAge = SESSION_DAYS * 86400;
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Parse and validate session cookie. Returns { authed, username, role } or { authed: false }. */
export function parseSession(req) {
  const raw   = req.headers?.cookie || "";
  const match = raw.split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`));
  if (!match) return { authed: false };

  const val   = match.slice(COOKIE.length + 1);
  const parts = val.split(".");
  // format: expiry.username.role.signature (username may contain dots — take last 2 as role.sig)
  if (parts.length < 4) return { authed: false };

  const expiry   = parts[0];
  const role     = parts[parts.length - 2];
  const sig      = parts[parts.length - 1];
  const username = parts.slice(1, parts.length - 2).join(".");

  if (!Number(expiry) || Number(expiry) < Date.now()) return { authed: false };
  if (!["admin", "viewer", "superadmin"].includes(role)) return { authed: false };

  const expected = sign(Number(expiry), username, role);
  if (!equal(sig, expected)) return { authed: false };

  return { authed: true, username, role };
}

export function isAuthed(req) {
  return parseSession(req).authed;
}

/**
 * Gate a handler. Returns session { username, role } when allowed,
 * otherwise writes the error response and returns null.
 */
export function guard(req, res) {
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    res.status(503).json({
      error: "not_configured",
      detail: "SUPER_ADMIN_PASSWORD is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.",
    });
    return null;
  }
  if (!redisConfig()) {
    res.status(503).json({
      error: "not_configured",
      detail: "No Redis store connected.",
    });
    return null;
  }
  const session = parseSession(req);
  if (!session.authed) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return session;
}
