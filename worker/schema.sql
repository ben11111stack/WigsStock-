-- WigsStock sync – D1 schema
-- Safe to re-run: everything is CREATE TABLE IF NOT EXISTS. The Worker also
-- creates these tables itself on first request (see ensureSchema in
-- src/worker.js), so a fresh D1 works even without running this file.

CREATE TABLE IF NOT EXISTS scans (
  count_id   TEXT    NOT NULL,   -- shared inventory-count id (all stations use the same one)
  device     TEXT    NOT NULL,   -- station / worker name
  barcode    TEXT    NOT NULL,   -- wig barcode
  count      INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER,
  PRIMARY KEY (count_id, device, barcode)
);
CREATE INDEX IF NOT EXISTS idx_scans_count ON scans (count_id);

-- Per-count metadata: inventory source, write-back target, reset generation,
-- and the shared app settings blob (accent/dark/sound/names/statusOverrides/…).
-- Only the per-device station name and connection details stay on the device;
-- everything else here syncs across stations.
CREATE TABLE IF NOT EXISTS meta (
  count_id     TEXT PRIMARY KEY,  -- shared inventory-count id
  sheet_url    TEXT,              -- Google Sheet the inventory loads from
  script_url   TEXT,              -- Apps Script web-app URL for write-back
  reset_at     INTEGER,           -- reset generation (stations clear on next pull)
  last_written INTEGER,           -- last successful write-back time
  settings     TEXT,              -- shared app settings, JSON blob
  settings_at  INTEGER,           -- when settings last changed (last-write-wins)
  updated_at   INTEGER
);

-- Central reset backups: a snapshot of a count's merged totals taken right
-- before each reset, so ANY station can restore — not just the device that
-- clicked reset. `data` is a JSON blob of { barcode: count }.
CREATE TABLE IF NOT EXISTS backups (
  id            TEXT PRIMARY KEY,  -- unique backup id (timestamp + random suffix)
  count_id      TEXT NOT NULL,     -- which count this backs up
  created_at    INTEGER NOT NULL,  -- when the reset (backup) happened
  by_who        TEXT,              -- station / user who triggered the reset
  total_scanned INTEGER,           -- distinct barcodes in the snapshot
  total_count   INTEGER,           -- sum of all counts in the snapshot
  data          TEXT NOT NULL      -- JSON: { barcode: count, ... }
);
CREATE INDEX IF NOT EXISTS idx_backups_count ON backups (count_id, created_at);
