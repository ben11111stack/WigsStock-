-- WigsStock sync – D1 schema
CREATE TABLE IF NOT EXISTS scans (
  count_id   TEXT    NOT NULL,   -- shared inventory-count id (all stations use the same one)
  device     TEXT    NOT NULL,   -- station / worker name
  barcode    TEXT    NOT NULL,   -- wig barcode
  count      INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER,
  PRIMARY KEY (count_id, device, barcode)
);
CREATE INDEX IF NOT EXISTS idx_scans_count ON scans (count_id);
