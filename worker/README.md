# WigsStock Sync – Cloudflare Worker

Cloud backend so scans survive a cleared device and merge across stations.

## Deploy (one time, ~2 min)

From this `worker/` folder:

```bash
# 1. log in (opens browser)
npx wrangler login

# 2. create the D1 database — copy the printed database_id into wrangler.toml
npx wrangler d1 create wigsstock

# 3. create the table (remote)
npx wrangler d1 execute wigsstock --remote --file=schema.sql

# 4. deploy
npx wrangler deploy
```

`wrangler deploy` prints your URL, e.g. `https://wigsstock-sync.<your-subdomain>.workers.dev`.

## Wire the app

Open the app → tab **מלאי** → **סנכרון ענן**:
- **כתובת השרת** = the Worker URL above
- **שם ספירה** = a shared name every station uses (e.g. `יולי-2026`)
- give each phone a different **עמדה** name (top-left)

That's it — every scan syncs, and each station sees the merged count.

## Endpoints
- `GET  /api/health`
- `POST /api/sync`  `{ count_id, device, scans: { barcode: count } }`
- `GET  /api/scans?count_id=...` → `{ scans: { barcode: total }, devices, barcodes }`
- `POST /api/reset`  `{ count_id, by }` → snapshots the count's merged totals into `backups`, then wipes. Returns `{ ok, deleted, reset_at, backup_id }`.
- `GET  /api/backups?count_id=...` → `{ backups: [{ id, created_at, by, total_scanned, total_count }] }` (newest first) — the restore points shown in the app under Settings → איפוס ושחזור.
- `POST /api/restore`  `{ count_id, backup_id, by, device_id }` → rewrites the count's scans to that snapshot and bumps `reset_at`, so every station converges on the restored counts on next pull. Admin-only. Returns `{ ok, restored, reset_at }`.
- `POST /api/claim-name`  `{ count_id, name, device_id }` → claims a unique station name (first device wins; a stale claim can be taken over after 12h) and heartbeats it. Returns `{ ok, owner, blocked, admin, rank }` or `409 { taken:true }`.
- `GET  /api/stations?count_id=&by=&device_id=` → admin-only list of all users `[{ name, blocked, online, rank, scans, is_you }]`.
- `POST /api/stations`  `{ count_id, by, device_id, action, name, new_name? }` → admin action `block` / `unblock` / `delete` / `rename`. The actor must strictly outrank the target (so `מרים` can't touch `מנג'ר`).

**Access control:** two admin names by rank — `מנג'ר` (2, super-admin) and `מרים` (1). Both can reset/restore/manage users; a management action needs the actor to strictly outrank the target. `/api/reset` and `/api/restore` require the caller to be the active holder of an admin-name claim. This is a soft gate (browser app) backed by unique-name claiming. To change the admin names, edit `ADMIN_RANKS` in `src/worker.js` **and** in the app's `app.js`.

## Reset / restore a count
The app does this from **Settings → איפוס ושחזור** (reset auto-backs up; any station can restore).
Manual wipe (does **not** create a backup):
```bash
npx wrangler d1 execute wigsstock --remote --command "DELETE FROM scans WHERE count_id='יולי-2026'"
```
