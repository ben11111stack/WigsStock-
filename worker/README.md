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

## Reset a count
```bash
npx wrangler d1 execute wigsstock --remote --command "DELETE FROM scans WHERE count_id='יולי-2026'"
```
