#!/usr/bin/env node
// Push a local JSON array of rota entries into a deployed QA Rota.
//
//   ROTA_URL=https://mumz-qa-rota.vercel.app \
//   ROTA_PASSWORD='the-team-password' \
//   node scripts/seed.mjs seed-rota-data.json
//
// This is a forced overwrite (it sends a bare array), so it replaces whatever
// is currently stored. Use it to seed an empty deployment or to restore a
// backup taken with the dashboard's Export button.
import { readFileSync } from "node:fs";

const url = (process.env.ROTA_URL || "").replace(/\/$/, "");
const password = process.env.ROTA_PASSWORD;
const file = process.argv[2] || "seed-rota-data.json";

if (!url || !password) {
  console.error("Set ROTA_URL and ROTA_PASSWORD. See the header of this file.");
  process.exit(1);
}

const entries = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(entries)) {
  console.error(`${file} must contain a JSON array of rota entries.`);
  process.exit(1);
}

const login = await fetch(`${url}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.error(`Login failed (${login.status}). Check ROTA_PASSWORD.`);
  process.exit(1);
}
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

const put = await fetch(`${url}/api/rota`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify(entries),
});
const body = await put.json().catch(() => ({}));
if (!put.ok) {
  console.error(`Seed failed (${put.status}):`, body);
  process.exit(1);
}
console.log(`Seeded ${body.count} entries into ${url} (version ${body.version}).`);
