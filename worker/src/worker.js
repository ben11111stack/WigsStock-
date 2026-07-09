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
