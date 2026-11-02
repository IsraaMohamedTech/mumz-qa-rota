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
// Employees + leaves calendar
//   rota:employees  hash, field <employee id> -> JSON { id, name, username,
//                   position, active, createdAt, updatedBy, updatedAt }
//   rota:leaves     hash, field "<employee id>|<YYYY-MM-DD>" -> JSON { t, title?, by, at }
// Both live in their own keys: nothing here reads or rewrites rota:data,
// rota:version or rota:users. Leaves are keyed by the employee's id, not their
// name, so renaming someone keeps their leave. One hash field per record means
// two people saving at once never touch the same field — no versioning needed.
// ---------------------------------------------------------------------------
const EMPLOYEES_KEY = "rota:employees";
const LEAVES_KEY    = "rota:leaves";

async function pipeline(commands) {
  const cfg = redisConfig();
  if (!cfg) throw new Error("STORAGE_NOT_CONFIGURED");
  const res = await fetch(`${cfg.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) throw new Error(`redis: pipeline ${res.status}`);
  return body.map((r) => r?.result);
}

// Upstash returns HGETALL as a flat [field, value, field, value, …] array
function parseHash(flat) {
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip a corrupt record */ }
  }
  return out;
}

export async function readEmployees() {
  const [flat] = await pipeline([["HGETALL", EMPLOYEES_KEY]]);
  return Object.values(parseHash(flat)).sort((a, b) => a.name.localeCompare(b.name));
}

export async function writeEmployee(emp) {
  await redis(["HSET", EMPLOYEES_KEY, emp.id, JSON.stringify(emp)]);
}

/** Delete an employee and every leave day stored under them. */
export async function deleteEmployee(id) {
  const [flat] = await pipeline([["HGETALL", LEAVES_KEY]]);
  const fields = Object.keys(parseHash(flat)).filter((f) => f.startsWith(`${id}|`));
  if (fields.length) await redis(["HDEL", LEAVES_KEY, ...fields]);
  await redis(["HDEL", EMPLOYEES_KEY, id]);
}

export async function readLeavesAndEmployees() {
  const [leaves, emps] = await pipeline([["HGETALL", LEAVES_KEY], ["HGETALL", EMPLOYEES_KEY]]);
  return {
    cells: parseHash(leaves),
    employees: Object.values(parseHash(emps)).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Set (type, optional title) or clear (type null) one employee's leave on a list of days. */
export async function writeLeaveDays(employeeId, dates, type, by, title) {
  const fields = dates.map((d) => `${employeeId}|${d}`);
  if (!fields.length) return;
  if (type) {
    const cell = { t: type, by, at: new Date().toISOString() };
    if (title) cell.title = title;
    const value = JSON.stringify(cell);
    await redis(["HSET", LEAVES_KEY, ...fields.flatMap((f) => [f, value])]);
  } else {
    await redis(["HDEL", LEAVES_KEY, ...fields]);
  }
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

/**
 * Update a user's username, role and/or password.
 * Returns { ok, error, username } — username is the name after any rename.
 */
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
    // Same floor as the self-service change, so a super-admin reset can't set a
    // weaker password than the user could set themselves.
    if (String(updates.password).length < 6) return { ok: false, error: "password_too_short" };
    users[idx].passwordHash = hashPassword(updates.password);
  }

  // Rename. Session cookies carry the username, so a renamed user's existing
  // session points at a name that no longer exists — they must sign in again.
  if (updates.username !== undefined) {
    const next = String(updates.username).trim().toLowerCase();
    if (!next) return { ok: false, error: "username_required" };
    if (!/^[a-z0-9._-]{2,32}$/.test(next)) return { ok: false, error: "invalid_username" };
    const superAdmin = (process.env.SUPER_ADMIN_USERNAME || "israa").toLowerCase();
    if (next === superAdmin) return { ok: false, error: "username_reserved" };
    if (next !== name && users.some(u => u.username === next)) return { ok: false, error: "username_taken" };
    users[idx].username = next;
  }

  await writeUsers(users);
  return { ok: true, username: users[idx].username };
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
