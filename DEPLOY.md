# Deploying the QA Rota to Vercel

Everything is built and tested. Three steps need a human because they involve
logging in and clicking in the Vercel dashboard.

## What you get

A single URL (e.g. `https://mumz-qa-rota.vercel.app`) that the whole QA team can
open from anywhere. Everyone sees and edits the same rota. One shared team
password gates it.

## Step 1 — log in to Vercel

In Claude Code, run this so the output lands in the session:

```
! vercel login
```

Pick your `israa@mumzworld.com` account.

## Step 2 — create the project and its Redis store

```
cd /Users/israa/qa-rota-vercel
vercel link          # create a new project, name it: mumz-qa-rota
```

Then in the Vercel dashboard: **Storage → Create Database → Upstash Redis**
(free tier is plenty — this rota uses a handful of commands per page view).
Connect it to the `mumz-qa-rota` project. Vercel injects `KV_REST_API_URL` and
`KV_REST_API_TOKEN` automatically; the code reads either those or the
`UPSTASH_REDIS_*` equivalents.

## Step 3 — set the two secrets

```
vercel env add ROTA_PASSWORD production     # the password you give the team
vercel env add ROTA_SECRET production       # any long random string, never shared
```

Generate a secret with:

```
openssl rand -hex 32
```

`ROTA_PASSWORD` is what the team types. `ROTA_SECRET` only signs session
cookies — nobody needs to know it. If `ROTA_PASSWORD` is missing the API
returns 503 rather than serving the rota unprotected.

## Step 4 — deploy

```
vercel --prod
```

Check it came up correctly:

```
curl -s https://<your-url>/api/health
```

Expect `{"ok":true,"passwordConfigured":true,"storeConfigured":true,"ready":true}`.
If either flag is `false`, the matching step above didn't take effect — set it
and redeploy.

## Step 5 — load the real rota

The historic entries live in your browser's localStorage on the old claude.ai
artifact, so they have to come out through the browser:

1. Open the old artifact, click **Export** — you get a JSON file
2. Seed it:

```
ROTA_URL=https://<your-url> ROTA_PASSWORD='the-password' \
  node scripts/seed.mjs ~/Downloads/<exported-file>.json
```

`/Users/israa/qa-rota-seed.json` holds the 2 on-call entries from the localhost
app, as a starting point if you'd rather not migrate the old artifact. It is
kept outside this folder deliberately — anything inside `public/` is served to
the internet, and rota data should never be reachable without the password.

Seeding is a forced overwrite, so it also works for restoring a backup.

## Notes

**Concurrent edits are safe.** Each save carries the version it was read at. If
a teammate saved first, your save is rejected with a 409, the dashboard pulls
their version, and it tells you to redo your change. Nothing is silently lost.
Before, the last person to save simply overwrote everyone else.

**Back it up.** The rota is one JSON blob in Redis. Hit **Export** in the
dashboard occasionally, or run:

```
curl -s -H "Cookie: rota_auth=..." https://<your-url>/api/rota > backup.json
```

**Vercel plan.** The Hobby plan is for non-commercial use only — an internal
Mumzworld tool is commercial use under Vercel's terms. It will deploy and run
fine, but to be above board this should sit on a Pro/Team account (or ask IT to
own it). Worth a quick word with IT before you circulate the link widely.

**No login of its own beyond the shared password.** One password for the team,
no per-person accounts and no audit trail of who changed what. Fine for a rota;
don't put anything more sensitive in it.
