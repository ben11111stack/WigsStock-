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
  'Access-Control-Allow-Headers': 'Content-Type,x-api-key',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });

// Optional shared secret. If API_KEY is set on the Worker (a Cloudflare
// secret / var), every mutating endpoint requires a matching x-api-key header.
// Unset = open, exactly like before — so this is safe to deploy as-is and can
// be switched on later with `wrangler secret put API_KEY` (no app change: paste
// the same key in the app's advanced settings). Reads stay open either way.
function authed(req, env) {
  if (!env || !env.API_KEY) return true;
  return req.headers.get('x-api-key') === env.API_KEY;
}

// Guardrails so a single request can't wedge the DB or blow past D1 limits.
const MAX_ID_LEN = 64;      // count_id / device
const MAX_BARCODE_LEN = 64;
const MAX_SCANS_PER_SYNC = 20000;

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

// Self-healing schema: create the tables if they're missing, so a freshly
// created D1 (e.g. after moving to a new Cloudflare account) works without a
// manual `wrangler d1 execute schema.sql` step. Runs once per isolate.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS scans (
       count_id TEXT NOT NULL, device TEXT NOT NULL, barcode TEXT NOT NULL,
       count INTEGER NOT NULL DEFAULT 1, updated_at INTEGER,
       PRIMARY KEY (count_id, device, barcode))`
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS meta (
       count_id TEXT PRIMARY KEY, sheet_url TEXT, script_url TEXT,
       reset_at INTEGER, last_written INTEGER,
       settings TEXT, settings_at INTEGER, updated_at INTEGER)`
  ).run();
  // Defensive: add the settings columns to a meta table that predates them.
  try { await env.DB.prepare(`ALTER TABLE meta ADD COLUMN settings TEXT`).run(); } catch (e) { /* exists */ }
  try { await env.DB.prepare(`ALTER TABLE meta ADD COLUMN settings_at INTEGER`).run(); } catch (e) { /* exists */ }
  schemaReady = true;
}

// Aggregate a count's scans per barcode: total, last time, and stations.
async function aggregateScans(env, countId) {
  const { results } = await env.DB.prepare(
    `SELECT barcode, SUM(count) AS total, MAX(updated_at) AS last, GROUP_CONCAT(DISTINCT device) AS devices
     FROM scans WHERE count_id = ?1 GROUP BY barcode`
  ).bind(countId).all();
  const scans = {};
  for (const r of results) {
    if (r.total > 0) scans[r.barcode] = { count: r.total, last: r.last || 0, station: r.devices || '' };
  }
  return scans;
}

// Fast, throttled write-back triggered right after new scans arrive, so the
// sheet updates within a few seconds instead of waiting for the cron.
async function maybeWriteback(env, countId) {
  try {
    const m = await env.DB.prepare(`SELECT script_url, last_written FROM meta WHERE count_id = ?1`).bind(countId).first();
    if (!m || !m.script_url) return;
    const now = Date.now();
    if (m.last_written && now - m.last_written < 5000) return;   // at most one write / 5s
    await env.DB.prepare(`UPDATE meta SET last_written = ?2 WHERE count_id = ?1`).bind(countId, now).run();
    await doWriteback(env, countId, m.script_url);
  } catch (e) { /* cron will catch up */ }
}

// Push a count's results to the owner's Apps Script web app. `fields` carries
// editable per-wig values (name/status) supplied by the writing device on a
// manual write-back; the cron/auto path sends scans only.
async function doWriteback(env, countId, scriptUrl, fields) {
  const scans = await aggregateScans(env, countId);
  const body = { scans };
  if (fields && Object.keys(fields).length) body.fields = fields;
  const r = await fetch(scriptUrl, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  try { return JSON.parse(text); }
  catch (e) { return { ok: false, error: 'unexpected response from Apps Script (deployed as web app, access = Anyone?)', raw: text.slice(0, 200) }; }
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/' || path === '/api/health') return json({ ok: true, service: 'wigsstock-sync' });

      // Gate mutating endpoints behind the optional shared secret.
      if (req.method === 'POST' && !authed(req, env)) return json({ error: 'unauthorized' }, 401);

      // Make sure the tables exist (self-heals a fresh D1 with no schema run).
      await ensureSchema(env);

      if (path === '/api/sync' && req.method === 'POST') {
        const body = await req.json();
        const countId = (body.count_id || '').trim();
        const device = (body.device || '').trim();
        const scans = body.scans || {};
        if (!countId || !device) return json({ error: 'count_id and device required' }, 400);
        if (countId.length > MAX_ID_LEN || device.length > MAX_ID_LEN) return json({ error: 'count_id/device too long' }, 400);

        const now = Date.now();
        const entries = Object.entries(scans)
          .filter(([bc]) => bc && String(bc).length <= MAX_BARCODE_LEN)
          .slice(0, MAX_SCANS_PER_SYNC);
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
        // fast sheet update: fire a throttled write-back without blocking the response
        if (synced > 0 && ctx && ctx.waitUntil) ctx.waitUntil(maybeWriteback(env, countId));
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

      // Write scan results back into the sheet via the owner's Apps Script
      // web app (server-side POST avoids browser CORS with Apps Script).
      if (path === '/api/writeback' && req.method === 'POST') {
        const body = await req.json();
        const countId = (body.count_id || '').trim();
        if (!countId) return json({ error: 'count_id required' }, 400);
        let scriptUrl = (body.script_url || '').trim();
        if (!scriptUrl) {
          const m = await env.DB.prepare(`SELECT script_url FROM meta WHERE count_id = ?1`).bind(countId).first();
          scriptUrl = m && m.script_url ? m.script_url : '';
        }
        if (!/^https:\/\/script\.google\.com\//.test(scriptUrl)) return json({ error: 'only Apps Script (script.google.com) URLs are allowed' }, 400);
        const result = await doWriteback(env, countId, scriptUrl, body.fields);
        return json(result, result && result.ok ? 200 : 502);
      }

      // Wipe an entire count (all devices) — used by the app's reset button.
      // Also bump reset_at so every station clears its local scans on next pull.
      if (path === '/api/reset' && req.method === 'POST') {
        const body = await req.json();
        const countId = (body.count_id || '').trim();
        if (!countId) return json({ error: 'count_id required' }, 400);
        const r = await env.DB.prepare('DELETE FROM scans WHERE count_id = ?1').bind(countId).run();
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO meta (count_id, reset_at, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(count_id) DO UPDATE SET reset_at = excluded.reset_at, updated_at = excluded.updated_at`
        ).bind(countId, now, now).run();
        return json({ ok: true, deleted: (r.meta && r.meta.changes) || 0, reset_at: now });
      }

      // Register the shared inventory source (Google Sheet link) for a count,
      // so every station auto-loads the same inventory.
      if (path === '/api/config' && req.method === 'POST') {
        const body = await req.json();
        const countId = (body.count_id || '').trim();
        if (!countId) return json({ error: 'count_id required' }, 400);
        const now = Date.now();
        await env.DB.prepare(`INSERT INTO meta (count_id, updated_at) VALUES (?1, ?2) ON CONFLICT(count_id) DO NOTHING`).bind(countId, now).run();
        // update only the fields that were provided (don't clobber the other)
        if (body.sheet_url !== undefined)
          await env.DB.prepare(`UPDATE meta SET sheet_url = ?2, updated_at = ?3 WHERE count_id = ?1`).bind(countId, String(body.sheet_url || '').trim(), now).run();
        if (body.script_url !== undefined)
          await env.DB.prepare(`UPDATE meta SET script_url = ?2, updated_at = ?3 WHERE count_id = ?1`).bind(countId, String(body.script_url || '').trim(), now).run();
        // Shared app settings (accent, dark, sound, names, statusOverrides, …) —
        // everything except the per-device station name and connection details.
        // Stored as one JSON blob with a timestamp; stations apply it last-write-wins.
        if (body.settings !== undefined && body.settings && typeof body.settings === 'object') {
          const blob = JSON.stringify(body.settings).slice(0, 200000);
          await env.DB.prepare(`UPDATE meta SET settings = ?2, settings_at = ?3, updated_at = ?3 WHERE count_id = ?1`).bind(countId, blob, now).run();
          return json({ ok: true, settings_at: now });
        }
        return json({ ok: true });
      }

      // Delete all scans of one barcode in a count (correction) — every station drops it on pull.
      if (path === '/api/delete-scan' && req.method === 'POST') {
        const body = await req.json();
        const countId = (body.count_id || '').trim();
        const barcode = String(body.barcode || '').trim();
        if (!countId || !barcode) return json({ error: 'count_id and barcode required' }, 400);
        const r = await env.DB.prepare('DELETE FROM scans WHERE count_id = ?1 AND barcode = ?2').bind(countId, barcode).run();
        // bump reset_at so stations reconcile (drop it locally) on next pull
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO meta (count_id, reset_at, updated_at) VALUES (?1, ?2, ?3)
           ON CONFLICT(count_id) DO UPDATE SET reset_at = excluded.reset_at, updated_at = excluded.updated_at`
        ).bind(countId, now, now).run();
        return json({ ok: true, deleted: (r.meta && r.meta.changes) || 0, reset_at: now });
      }

      if (path === '/api/scans' && req.method === 'GET') {
        const countId = (url.searchParams.get('count_id') || '').trim();
        if (!countId) return json({ error: 'count_id required' }, 400);
        const { results } = await env.DB
          .prepare(`SELECT barcode, SUM(count) AS total, MAX(updated_at) AS last, GROUP_CONCAT(DISTINCT device) AS devices
                    FROM scans WHERE count_id = ?1 GROUP BY barcode`)
          .bind(countId).all();
        const scans = {}, detail = {};
        for (const r of results) if (r.total > 0) {
          scans[r.barcode] = r.total;
          detail[r.barcode] = { count: r.total, last: r.last || 0, station: r.devices || '' };
        }

        const dev = await env.DB
          .prepare(`SELECT COUNT(DISTINCT device) AS n FROM scans WHERE count_id = ?1`)
          .bind(countId).first();

        let sheetUrl = '', resetAt = 0, settings = null, settingsAt = 0;
        try {
          const m = await env.DB.prepare(`SELECT sheet_url, reset_at, settings, settings_at FROM meta WHERE count_id = ?1`).bind(countId).first();
          if (m) {
            sheetUrl = m.sheet_url || ''; resetAt = m.reset_at || 0;
            settingsAt = m.settings_at || 0;
            if (m.settings) { try { settings = JSON.parse(m.settings); } catch (e) { settings = null; } }
          }
        } catch (e) { /* meta table may not exist yet */ }

        return json({ ok: true, scans, detail, barcodes: Object.keys(scans).length, devices: dev ? dev.n : 0, sheet_url: sheetUrl, reset_at: resetAt, settings, settings_at: settingsAt });
      }

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },

  // Cron: auto-write results to the sheet for any count that has a script_url
  // and new scans since the last write.
  async scheduled(event, env, ctx) {
    try {
      await ensureSchema(env);
      const { results } = await env.DB
        .prepare(`SELECT count_id, script_url, last_written FROM meta WHERE script_url IS NOT NULL AND script_url != ''`)
        .all();
      for (const m of results) {
        const mx = await env.DB.prepare(`SELECT MAX(updated_at) AS mx FROM scans WHERE count_id = ?1`).bind(m.count_id).first();
        if (!mx || !mx.mx) continue;
        if (m.last_written && mx.mx <= m.last_written) continue;   // nothing new since last write
        const res = await doWriteback(env, m.count_id, m.script_url);
        if (res && res.ok) {
          await env.DB.prepare(`UPDATE meta SET last_written = ?2 WHERE count_id = ?1`).bind(m.count_id, Date.now()).run();
        }
      }
    } catch (e) { /* swallow — next tick retries */ }
  },
};
