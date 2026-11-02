#!/usr/bin/env node
// Local test server: serves public/ and runs the api/*.js handlers exactly as
// Vercel would, against an IN-MEMORY Redis stand-in. Nothing here can reach
// the live Upstash store, and everything is gone when you stop the server.
//
//   node scripts/dev-server.mjs          # then open http://localhost:3005
//
// Test accounts (local only):
//   israa / dev-pass   super admin
//   sara  / dev-pass   admin
//   omar  / dev-pass   viewer
//   lina  / dev-pass   viewer (no employee linked yet — try linking her)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const PORT = Number(process.env.PORT || 3005);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Point the API at the fake store before any handler module is loaded.
process.env.KV_REST_API_URL = `http://localhost:${PORT}/__redis`;
process.env.KV_REST_API_TOKEN = "local-dev";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
process.env.SUPER_ADMIN_USERNAME = "israa";
process.env.SUPER_ADMIN_PASSWORD = "dev-pass";
process.env.ROTA_SECRET = randomBytes(32).toString("hex");

// ---- In-memory Redis (only the commands this app uses) --------------------
const kv = new Map();      // strings
const hashes = new Map();  // key -> Map
const sets = new Map();    // key -> Set
function run([cmd, ...a]) {
  switch (String(cmd).toUpperCase()) {
    case "GET": return kv.has(a[0]) ? kv.get(a[0]) : null;
    case "SET": kv.set(a[0], String(a[1])); return "OK";
    case "INCR": { const n = Number(kv.get(a[0]) || 0) + 1; kv.set(a[0], String(n)); return n; }
    case "EVAL": {
      // The rota's compare-and-set script: KEYS = version, data; ARGV = expected, payload
      const [, , vKey, dKey, expected, payload] = a;
      if ((kv.get(vKey) || "0") !== expected) return -1;
      kv.set(dKey, payload);
      return run(["INCR", vKey]);
    }
    case "HSET": {
      const h = hashes.get(a[0]) || new Map(); hashes.set(a[0], h);
      let added = 0;
      for (let i = 1; i + 1 < a.length; i += 2) { if (!h.has(a[i])) added++; h.set(a[i], String(a[i + 1])); }
      return added;
    }
    case "HDEL": { const h = hashes.get(a[0]); let n = 0; if (h) for (const f of a.slice(1)) n += h.delete(f) ? 1 : 0; return n; }
    case "HGETALL": { const h = hashes.get(a[0]); return h ? [...h].flat() : []; }
    case "SADD": { const s = sets.get(a[0]) || new Set(); sets.set(a[0], s); let n = 0; for (const m of a.slice(1)) if (!s.has(m)) { s.add(m); n++; } return n; }
    case "SREM": { const s = sets.get(a[0]); let n = 0; if (s) for (const m of a.slice(1)) n += s.delete(m) ? 1 : 0; return n; }
    case "SMEMBERS": return [...(sets.get(a[0]) || [])];
    default: throw new Error(`fake redis: ${cmd} not implemented`);
  }
}

// ---- Vercel-style req/res adapter -----------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const handlers = {};
async function handlerFor(name) {
  if (!(name in handlers)) {
    try { handlers[name] = (await import(join(ROOT, "api", `${name}.js`))).default; }
    catch { handlers[name] = null; }
  }
  return handlers[name];
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => resolve(s));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const raw = await readBody(req);

  if (url.pathname === "/__redis" || url.pathname === "/__redis/pipeline") {
    res.setHeader("Content-Type", "application/json");
    try {
      const body = JSON.parse(raw || "null");
      if (url.pathname.endsWith("/pipeline")) return res.end(JSON.stringify(body.map((c) => ({ result: run(c) }))));
      return res.end(JSON.stringify({ result: run(body) }));
    } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: String(e.message) })); }
  }

  if (url.pathname.startsWith("/api/")) {
    let [, , name, ...rest] = url.pathname.split("/");
    const query = Object.fromEntries(url.searchParams);
    if (name === "users" && rest.length) query.path = rest.join("/"); // mirrors vercel.json rewrite
    const handler = await handlerFor(name);
    if (!handler) { res.statusCode = 404; return res.end("not found"); }
    let body = raw;
    if ((req.headers["content-type"] || "").includes("application/json")) { try { body = JSON.parse(raw || "null"); } catch {} }
    const vreq = Object.assign(req, { query, body });
    const vres = {
      status(c) { res.statusCode = c; return vres; },
      setHeader(k, v) {
        // Browsers drop Secure cookies on plain http in some cases (Safari) — strip it locally only
        if (String(k).toLowerCase() === "set-cookie") v = String(v).replace(/;\s*Secure/i, "");
        res.setHeader(k, v); return vres;
      },
      json(o) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return vres; },
      send(s) { res.end(s); return vres; },
      end(s) { res.end(s); return vres; },
    };
    try { await handler(vreq, vres); }
    catch (e) { if (!res.headersSent) { res.statusCode = 500; res.end(String(e.stack || e)); } }
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (file.includes("..")) { res.statusCode = 400; return res.end(); }
  try {
    const buf = await readFile(join(ROOT, "public", file));
    res.setHeader("Content-Type", TYPES[extname(file)] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  } catch { res.statusCode = 404; res.end("not found"); }
});

server.listen(PORT, async () => {
  // Seed local-only test users, employees and a few leave days
  const { createUser, writeEmployee, writeLeaveDays } = await import(join(ROOT, "api", "_lib.js"));
  await createUser("sara", "dev-pass", "admin");
  await createUser("omar", "dev-pass", "viewer");
  await createUser("lina", "dev-pass", "viewer");   // login with no employee yet
  const now = new Date().toISOString();
  const emp = (id, name, username, position) =>
    writeEmployee({ id, name, username, position, active: true, createdAt: now, updatedBy: "israa", updatedAt: now });
  await emp("e-israa", "Israa Mohamed", "israa", "QA Lead");
  await emp("e-sara", "Sara Ahmed", "sara", "Senior QA");
  await emp("e-omar", "Omar Khalid", "omar", "QA Engineer");
  await emp("e-guest", "Guest Tester", "", "Contractor");
  await writeLeaveDays("e-sara", ["2026-12-07", "2026-12-08", "2026-12-09"], "annual", "sara");
  await writeLeaveDays("e-omar", ["2026-12-10"], "sick", "omar");
  await writeLeaveDays("e-israa", ["2026-12-14", "2026-12-15"], "wfh", "israa");
  console.log(`\nQA Rota (LOCAL, in-memory data) → http://localhost:${PORT}`);
  console.log("Accounts: israa / sara (admin) / omar, lina (viewers) — password dev-pass\n");
});
