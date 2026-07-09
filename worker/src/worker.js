/* =====================================================================
 * WigsStock sync – Cloudflare Worker + D1
 * ---------------------------------------------------------------------
 * Stores scans in the cloud so they survive a cleared device and merge
 * across multiple scanning stations in real time.
 *
 * Data model: one row per (count_id, device, barcode) holding that
 * device's absolute count. Syncing is idempotent — a device pushes the
 * current count for its changed barcodes, so retries never double-count.
 * The merged view sums counts across all devices for a count_id.
 *
 * Endpoints (all JSON, CORS open):
 *   GET  /api/health
 *   POST /api/sync   { count_id, device, scans: { barcode: count, ... } }
 *   GET  /api/scans?count_id=...   -> { scans: { barcode: total }, ... }
 * ===================================================================== */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// Turn any Google Sheets link into a CSV export URL.
function normalizeSheetUrl(src) {
  src = src.trim();
  if (/output=csv|format=csv/.test(src)) return src;          // already a CSV link
  const idm = src.match(/\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9\-_]+)/);
  if (!idm) return src;
  const id = idm[1];
  const gidm = src.match(/[#&?]gid=([0-9]+)/);
  const gid = gidm ? gidm[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/api/health') return json({ ok: true, service: 'wigsstock-sync' });

      if (path === '/api/sync' && req.method === 'POST') {
        const body = await req.json();
        const countId = (body.count_id || '').trim();
        const device = (body.device || '').trim();
        const scans = body.scans || {};
        if (!countId || !device) return json({ error: 'count_id and device required' }, 400);

        const now = Date.now();
        const entries = Object.entries(scans);
        // chunk so we never exceed D1 batch limits on a big first sync
        let synced = 0;
        for (let i = 0; i < entries.length; i += 50) {
          const chunk = entries.slice(i, i + 50);
          const stmts = chunk.map(([barcode, count]) =>
            env.DB.prepare(
              `INSERT INTO scans (count_id, device, barcode, count, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(count_id, device, barcode)
               DO UPDATE SET count = excluded.count, updated_at = excluded.updated_at`
            ).bind(countId, device, String(barcode), count | 0, now)
          );
          if (stmts.length) { await env.DB.batch(stmts); synced += stmts.length; }
        }
        return json({ ok: true, synced });
      }

      // Proxy a Google Sheet as CSV (server-side avoids browser CORS limits).
      // The sheet must be shared "anyone with the link can view" (or published).
      if (path === '/api/sheet' && req.method === 'GET') {
        const src = (url.searchParams.get('url') || '').trim();
        if (!src) return json({ error: 'url required' }, 400);
        const target = normalizeSheetUrl(src);
        if (!/^https:\/\/docs\.google\.com\//.test(target)) return json({ error: 'only Google Sheets links are allowed' }, 400);
        const r = await fetch(target, { redirect: 'follow', headers: { 'User-Agent': 'wigsstock-sync' } });
        if (!r.ok) return json({ error: 'could not read the sheet (' + r.status + ') — is it shared "anyone with the link"?' }, 502);
        const csv = await r.text();
        if (/<html/i.test(csv.slice(0, 200))) return json({ error: 'the sheet is not public — set sharing to "anyone with the link can view"' }, 502);
        return new Response(csv, { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', ...CORS } });
      }

      if (path === '/api/scans' && req.method === 'GET') {
        const countId = (url.searchParams.get('count_id') || '').trim();
        if (!countId) return json({ error: 'count_id required' }, 400);
        const { results } = await env.DB
          .prepare(`SELECT barcode, SUM(count) AS total FROM scans WHERE count_id = ?1 GROUP BY barcode`)
          .bind(countId).all();
        const scans = {};
        for (const r of results) if (r.total > 0) scans[r.barcode] = r.total;

        const dev = await env.DB
          .prepare(`SELECT COUNT(DISTINCT device) AS n FROM scans WHERE count_id = ?1`)
          .bind(countId).first();

        return json({ ok: true, scans, barcodes: Object.keys(scans).length, devices: dev ? dev.n : 0 });
      }

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
