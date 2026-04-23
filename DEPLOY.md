# DreamSonic — Deploy Guide

Start-to-finish checklist for putting this app on Railway at **dreamsonic.org**.

---

## 1. Create the GitHub repo

1. On GitHub: **+ New repository** → name it `dreamsonic` (or whatever you like).
   Keep it **private** for now.
2. Do NOT initialize with README/license/gitignore — those are already in this folder.
3. Locally, from wherever you unzipped these files:

```bash
cd dreamsonic
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/<your-username>/dreamsonic.git
git push -u origin main
```

---

## 2. Create the Railway project

1. Go to **railway.app** → **+ New Project**
2. Choose **Deploy from GitHub repo** → select the `dreamsonic` repo
3. Railway will start building automatically. It will fail the first deploy
   because there's no database yet — that's fine, we fix it in step 3.

---

## 3. Add Postgres

1. In the Railway project → **+ New** → **Database** → **Add PostgreSQL**
2. Wait for it to provision (about 30 seconds)
3. Click the new Postgres service → **Variables** tab → copy the value of `DATABASE_URL`
4. Go back to the `dreamsonic` web service → **Variables** tab → click **+ New Variable**
   - **Key:** `DATABASE_URL`
   - **Value:** paste the URL from step 3

*Alternative:* Railway lets you reference variables between services. In the
web service variables, you can type `${{Postgres.DATABASE_URL}}` instead of
pasting — this auto-updates if the DB URL ever rotates. Either works.

5. Railway auto-redeploys. Watch the deploy logs. You should see:

```
[dreamsonic] starting...
[schema] initializing...
[schema] ready
[seed] seeding defaults...
[seed] ready — 6 protocols, 19 vocab terms
[dreamsonic] listening on :XXXX
```

If you see `DATABASE_URL not set` — the variable didn't save. Re-check step 4.

---

## 4. Hook up the domain

1. In the `dreamsonic` web service → **Settings** tab → **Networking** section
2. Click **Generate Domain** for a free `*.up.railway.app` URL (good for testing first)
3. For the real **dreamsonic.org** domain:
   - **Custom Domain** → enter `dreamsonic.org`
   - Railway shows you a CNAME value to add at your DNS registrar
   - Log in to your domain registrar → DNS settings → add the CNAME record Railway specified
   - DNS propagation can take 1–30 minutes. Railway auto-issues an SSL cert once it sees the CNAME.
4. Also add `www.dreamsonic.org` as a second custom domain with its own CNAME, so both resolve.

---

## 5. First smoke test

Once `https://dreamsonic.org` loads:

1. You should see the dashboard (empty).
2. Click **+ New Client**
3. Run yourself through intake: basic info → medical screening (all NO on risk flags, YES on "no concerns") → type your full name on consent.
4. Back on dashboard → click your client name → **+ Schedule Session** → pick **Deep Calm** → leave time blank → EEG Source = **Simulator** → Schedule.
5. You land on the session runner → click **Connect Headband** (simulator connects instantly) → **Start Session** → rate pre-session 1–10 → Begin Baseline.
6. Watch the alpha bar turn green during the stimulus phase. That's the simulator demonstrating entrainment.
7. **Next Phase →** to skip through, then finalize with post-ratings and vocab chips.
8. Open `/client/:id` — the session is in history with Δstress / Δfocus / target gain.
9. Copy the client portal link (shown on the client detail page), open it on your phone — the progress view loads at `/w/:external_id`.

Pipeline works? You're done. Everything else is cosmetic.

---

## 6. When the BrainBit hardware arrives

The Web Bluetooth adapter is already wired in. Two things to do:

**a) Fill in the real BrainBit GATT UUIDs.** Open `public/eeg-source.js` and find the two `TODO(cap)` markers:

```js
const BRAINBIT_SERVICE_UUID = 'b4e4a2c0-0000-0000-0000-BRAINBITSDK01';   // PLACEHOLDER
const BRAINBIT_DATA_CHAR_UUID = 'b4e4a2c0-0000-0000-0000-BRAINBITSDK02'; // PLACEHOLDER
```

Get the real UUIDs from **https://sdk.brainbit.com** and replace both lines.

**b) Verify the packet parser.** Same file, the `_onPacket` function. Template is 4 channels × 24-bit signed little-endian with a 0.0298 µV scaler. Confirm against BrainBit's SDK docs and adjust if needed.

Commit, push, Railway auto-deploys. Flip a session's EEG source to **BrainBit via Bluetooth** in the schedule dialog — you're streaming real EEG through the same pipeline as the simulator.

---

## 7. Requirements / compatibility

- **Browser:** Web Bluetooth mode requires Chrome, Edge, Opera, or Brave. No Safari or Firefox. Pin the wellness room's coach device to Chrome. Simulator mode works in any modern browser.
- **HTTPS:** Web Bluetooth requires HTTPS. Railway auto-issues SSL certs for custom domains.
- **Node:** ≥ v20 (see `package.json` engines field)
- **Dependencies:** `express` and `pg` — nothing else
- **Postgres:** Uses `pgcrypto` for UUID generation. Railway Postgres permits this. The schema auto-runs `CREATE EXTENSION IF NOT EXISTS "pgcrypto"` on first boot.

---

## 8. Routine operations

### Viewing logs

Railway dashboard → web service → **Deployments** → click active deploy → **View Logs**. Live tail available.

### Backing up the database

Railway Postgres has automated daily backups on their paid plan. To manually snapshot:

```bash
# From your local machine with psql installed:
pg_dump "$DATABASE_URL" > dreamsonic-backup-$(date +%F).sql
```

Paste `DATABASE_URL` from the Railway Postgres Variables tab (don't commit it).

### Deploying a code change

```bash
git add .
git commit -m "describe the change"
git push
```

Railway auto-redeploys within ~30 seconds. Zero-downtime for stateless code changes.

### Rolling back

Railway dashboard → **Deployments** → find a previous successful deploy → **⋯** menu → **Redeploy**.

---

## 9. Things not built yet (by design)

- **Auth.** There's no login gate on the coach pages. For v1 you're relying on the domain being unpublicized and the coach device being trusted. Before any public signup flow, add HTTP basic auth middleware or integrate Google OAuth.
- **Raw EEG file archival.** `raw_eeg_file_ref` column exists but no uploader writes to it yet.
- **SMS/email sending for client portal links.** The `/w/:external_id` URL is displayed for manual copy. Wire into a provider (Twilio, Postmark) when ready.
- **Audio/light output.** The session runner tracks the protocol and reads EEG — the actual flashing/tones happen on whatever BrainBit-ecosystem playback tool you plug into the headphones and eye-shield. This is intentional; audio rendering in-browser is its own rabbit hole.

---

**Col 3:23.**
