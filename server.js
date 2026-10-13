/**
 * Hostel Space Finder — Production Server (Supabase + Render + Vercel)
 * ---------------------------------------------------------------------------
 * Stack:
 *   - Postgres (Supabase)     — all persistent data
 *   - connect-pg-simple       — server-side sessions in Postgres
 *   - Puppeteer               — BIU portal automation
 *   - Express                 — API
 *
 * Deploy: Backend → Render | Frontend → Vercel | DB → Supabase
 *
 * Run:  node server.js
 * Deps: express express-session connect-pg-simple pg bcryptjs
 *       puppeteer chalk dotenv
 */

'use strict';

// ===========================================================================
// 0. BOOT — env loading + validation
// ===========================================================================
try { require('dotenv').config(); } catch { /* optional */ }

const REQUIRED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'CREDENTIAL_KEY'];
const PLACEHOLDER_PATTERNS = [
  /PASTE_/i, /YOUR_DB_PASSWORD/i, /YOUR_REGION/i,
  /REPLACE_WITH_/i, /abcdefghijklmnop/i,
];
(function validateEnv() {
  const errors = [];
  for (const key of REQUIRED_ENV) {
    const val = process.env[key];
    if (!val) errors.push(`Missing env var: ${key}`);
    else if (PLACEHOLDER_PATTERNS.some(p => p.test(val))) {
      errors.push(`Env var ${key} still contains a placeholder`);
    }
  }
  if (errors.length) {
    console.error('❌ Environment validation failed:\n' + errors.map(e => '  - ' + e).join('\n'));
    process.exit(1);
  }
  console.log('✅ Environment validated');
})();

// ===========================================================================
// 1. IMPORTS
// ===========================================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

let chalk;
try { chalk = require('chalk'); } catch {
  const id = (s) => s;
  chalk = new Proxy({}, { get: () => id });
}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const DATA_DIR   = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');

// ===========================================================================
// 2. utils/logger.js
// ===========================================================================
const logger = (() => {
  const SENSITIVE = ['password', 'passwd', 'token', 'secret', 'authorization', 'cookie', 'apikey'];
  const redact = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const clone = Array.isArray(obj) ? [] : {};
    for (const k of Object.keys(obj)) {
      if (SENSITIVE.some(s => k.toLowerCase().includes(s))) clone[k] = '[REDACTED]';
      else if (typeof obj[k] === 'object') clone[k] = redact(obj[k]);
      else clone[k] = obj[k];
    }
    return clone;
  };
  const write = (level, msg, meta) => {
    const line = `[${new Date().toISOString()}] [${level}] ${msg}` +
      (meta ? ' ' + JSON.stringify(redact(meta)) : '');
    (level === 'ERROR' ? console.error : console.log)(line);
  };
  return {
    info:  (m, x) => write('INFO',  m, x),
    warn:  (m, x) => write('WARN',  m, x),
    error: (m, x) => write('ERROR', m, x),
    debug: (m, x) => !IS_PROD && write('DEBUG', m, x),
  };
})();

// ===========================================================================
// 3. utils/dates.js
// ===========================================================================
const dates = {
  now:     () => new Date().toISOString(),
  today:   () => new Date().toISOString().slice(0, 10),
  daysAgo: (n) => new Date(Date.now() - n * 86400000).toISOString(),
  format:  (d) => new Date(d).toISOString(),
  range:   (from, to) => ({ from: dates.format(from), to: dates.format(to) }),
};

// ===========================================================================
// 4. DATABASE — Postgres pool (Supabase)
// ===========================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on('error', (err) => logger.error('Unexpected pool error', { err: err.message }));

async function initDatabase() {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    logger.info('Postgres connected', { now: rows[0].now });

    // Ensure session table exists (safe to run on every boot)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`);

    // Ensure settings table exists (used before first seed)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    logger.info('Session + settings tables verified');
  } catch (err) {
    logger.error('Database connection failed', { err: err.message });
    process.exit(1);
  }
}

// ===========================================================================
// 5. config/hostelConfig.js — REAL CONFIG
// ===========================================================================
const hostelConfig = {
  Legacy: {
    boys: {
      flats: {
        "ABOVE ONLY OKHA": {
          hostel_id: 1, flats: 9,
          roomsPerFlat: { default: 4, exceptions: { 1: 3, 4: 3, 7: 3 } },
          bedsPerRoom: 4,
        },
        "BALM OF GILEAD OKHA": {
          hostel_id: 2, flats: 9,
          roomsPerFlat: { default: 4, exceptions: { 1: 3, 4: 3, 7: 3 } },
          bedsPerRoom: 4,
        },
      },
      floors: {
        "CHAMPIONS OKHA":   { hostel_id: 3, floors: ["A", "B", "C"], roomsPerFloor: 18, bedsPerRoom: 4 },
        "GRACE OKHA":       { hostel_id: 4, floors: ["A", "B", "C"], roomsPerFloor: 18, bedsPerRoom: 4 },
        "HOPE OKHA":        { hostel_id: 5, floors: ["A", "B", "C"], roomsPerFloor: 18, bedsPerRoom: 4 },
        "LOVE OKHA":        { hostel_id: 6, floors: ["A", "B", "C"], roomsPerFloor: 18, bedsPerRoom: 4 },
        "PEACE (OKHA CAMPUS) OKHA": { hostel_id: 7, floors: ["A", "B", "C"], roomsPerFloor: 18, bedsPerRoom: 4 },
        "SPLENDOR OKHA":    { hostel_id: 8, floors: ["A", "B", "C"], roomsPerFloor: 18, bedsPerRoom: 4 },
      },
    },
    girls: {
      floors: {
        "PURPOSE OKHA": { hostel_id: 9,  floors: ["A", "B", "C"], roomsPerFloor: 24, bedsPerRoom: 6 },
        "FAVOR OKHA":   { hostel_id: 10, floors: ["A", "B", "C"], roomsPerFloor: 24, bedsPerRoom: 6 },
        "DESTINY OKHA": { hostel_id: 11, floors: ["A", "B", "C"], roomsPerFloor: 24, bedsPerRoom: 6 },
      },
    },
  },
  Heritage: {
    boys: {
      floors: {
        "WISDOM BOYS HOSTEL": { hostel_id: 20, floors: ["A"], roomsPerFloor: { A: 12 }, bedsPerRoom: 4 },
        "PEACE HOSTEL":       { hostel_id: 21, floors: ["A", "B", "C", "D"], roomsPerFloor: { A: 13, B: 15, C: 15, D: 15 }, bedsPerRoom: 4 },
      },
      flats: {
        "VALOR HOSTEL":                 { hostel_id: 18, flats: 9, roomsPerFlat: { default: 4 }, bedsPerRoom: 4 },
        "BISHOP'S COURT HOSTEL (MALE)": { hostel_id: 19, flats: 3, roomsPerFlat: { default: 4 }, bedsPerRoom: 4 },
      },
    },
    girls: {
      floors: {
        "FAITH HOSTEL":        { hostel_id: 12, floors: ["A", "B", "C", "D"], roomsPerFloor: { A: 16, B: 18, C: 16, D: 10 }, bedsPerRoom: 4 },
        "VIRTUE HOSTEL":       { hostel_id: 13, floors: ["E", "F", "G", "H"], roomsPerFloor: { E: 19, F: 19, G: 19, H: 12 }, bedsPerRoom: 4 },
        "WISDOM GIRLS HOSTEL": { hostel_id: 14, floors: ["B", "C"],           roomsPerFloor: { B: 13, C: 13 },         bedsPerRoom: 4 },
        "AGAPE HOSTEL":        { hostel_id: 15, floors: ["A", "B", "C"],      roomsPerFloor: { A: 16, B: 16, C: 16 },  bedsPerRoom: 4 },
        "OVERCOMERS HOSTEL":   { hostel_id: 16, floors: ["A", "B", "C", "D"], roomsPerFloor: { A: 14, B: 16, C: 16, D: 16 }, bedsPerRoom: 4 },
      },
      flats: {
        "BISHOP'S COURT HOSTEL (FEMALE)": {
          hostel_id: 17, flats: [4, 5, 6, 7, 8, 9],
          roomsPerFlat: { default: 4 }, bedsPerRoom: 4,
        },
      },
    },
  },
};

function flattenHostelConfig() {
  const out = [];
  for (const campusName of Object.keys(hostelConfig)) {
    const campus = hostelConfig[campusName];
    for (const gender of ['boys', 'girls']) {
      if (!campus[gender]) continue;
      for (const structure of ['flats', 'floors']) {
        const group = campus[gender][structure];
        if (!group) continue;
        for (const hostelName of Object.keys(group)) {
          const def = group[hostelName];
          const units = [];
          if (structure === 'flats') {
            const flatNos = Array.isArray(def.flats)
              ? def.flats
              : Array.from({ length: def.flats || 0 }, (_, i) => i + 1);
            for (const fno of flatNos) {
              const roomCount =
                def.roomsPerFlat && def.roomsPerFlat.exceptions && def.roomsPerFlat.exceptions[fno] != null
                  ? def.roomsPerFlat.exceptions[fno]
                  : (def.roomsPerFlat && def.roomsPerFlat.default) || 4;
              units.push({
                unitId: `FLAT ${fno}`, unitName: `Flat ${fno}`,
                rooms: Array.from({ length: roomCount }, (_, i) => `ROOM ${i + 1}`),
              });
            }
          } else {
            for (const fl of (def.floors || [])) {
              const roomCount = typeof def.roomsPerFloor === 'number'
                ? def.roomsPerFloor
                : (def.roomsPerFloor && def.roomsPerFloor[fl]) || 0;
              units.push({
                unitId: `${fl} FLOOR`, unitName: `${fl} Floor`,
                rooms: Array.from({ length: roomCount }, (_, i) => `ROOM ${i + 1}`),
              });
            }
          }
          out.push({
            campusId: campusName.toLowerCase(),
            campusName, gender, structure,
            hostelId: `${campusName.toLowerCase()}-${hostelName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            hostelName, portalId: def.hostel_id,
            bedsPerRoom: def.bedsPerRoom || 4,
            units,
          });
        }
      }
    }
  }
  return out;
}

// ===========================================================================
// 6. REPOSITORIES — Postgres (async)
// ===========================================================================
const repos = {
  users: {
    async findByUsername(username) {
      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      return rows[0] || null;
    },
    async findById(id) {
      const { rows } = await pool.query(
        'SELECT id, username, role, created_at FROM users WHERE id = $1', [id]);
      return rows[0] || null;
    },
  },

  campuses: {
    async all() {
      const { rows } = await pool.query('SELECT * FROM campuses ORDER BY name');
      return rows;
    },
  },

  hostels: {
    async all() {
      const { rows } = await pool.query('SELECT * FROM hostels ORDER BY name');
      return rows;
    },
    async byCampus(campusId) {
      const { rows } = await pool.query(
        'SELECT * FROM hostels WHERE campus_id = $1 ORDER BY name', [campusId]);
      return rows;
    },
    async find(id) {
      const { rows } = await pool.query('SELECT * FROM hostels WHERE id = $1', [id]);
      return rows[0] || null;
    },
  },

  rooms: {
    async byHostel(hostelId) {
      const { rows } = await pool.query(
        'SELECT * FROM rooms WHERE hostel_id = $1 ORDER BY id', [hostelId]);
      return rows;
    },
  },

  beds: {
    async byRoom(roomId) {
      const { rows } = await pool.query(
        'SELECT * FROM bed_spaces WHERE room_id = $1 ORDER BY label', [roomId]);
      return rows;
    },
  },

  students: {
    async search({ q, hostelId, roomId, matric } = {}) {
      const where = [];
      const params = [];
      if (matric) { params.push(matric); where.push(`s.matric_number = $${params.length}`); }
      if (q) {
        params.push(`%${q}%`, `%${q}%`);
        where.push(`(s.full_name ILIKE $${params.length - 1} OR s.matric_number ILIKE $${params.length})`);
      }
      let sql = 'SELECT DISTINCT s.* FROM students s';
      if (hostelId || roomId) {
        sql += ' JOIN allocations a ON a.student_id = s.id';
        if (hostelId) { params.push(hostelId); where.push(`a.hostel_id = $${params.length}`); }
        if (roomId)   { params.push(roomId);   where.push(`a.room_id = $${params.length}`); }
      }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY s.full_name LIMIT 500';
      const { rows } = await pool.query(sql, params);
      return rows;
    },
    async create({ matric_number, full_name, gender, level, department }) {
      const { rows } = await pool.query(
        `INSERT INTO students (matric_number, full_name, gender, level, department)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [matric_number, full_name, gender || null, level || null, department || null]);
      return rows[0];
    },
  },

  allocations: {
    async active() {
      const { rows } = await pool.query("SELECT * FROM allocations WHERE status = 'active'");
      return rows;
    },
    async byStudent(studentId) {
      const { rows } = await pool.query(
        'SELECT * FROM allocations WHERE student_id = $1 ORDER BY id DESC', [studentId]);
      return rows;
    },
    async byBed(bedSpaceId) {
      const { rows } = await pool.query(
        "SELECT * FROM allocations WHERE bed_space_id = $1 AND status = 'active'",
        [bedSpaceId]);
      return rows[0] || null;
    },
    async create(a) {
      const { rows } = await pool.query(
        `INSERT INTO allocations
           (student_id, campus_id, hostel_id, room_id, bed_space_id, reference, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *`,
        [a.student_id, a.campus_id || null, a.hostel_id || null,
         a.room_id || null, a.bed_space_id || null, a.reference || null]);
      return rows[0];
    },
  },

  scans: {
    async create({ scope, campus_id, hostel_id }) {
      const { rows } = await pool.query(
        `INSERT INTO scans (status, scope, campus_id, hostel_id)
         VALUES ('queued', $1, $2, $3) RETURNING *`,
        [scope || null, campus_id || null, hostel_id || null]);
      return rows[0];
    },
    async update(id, patch) {
      const fields = Object.keys(patch);
      if (!fields.length) return this.find(id);
      const params = fields.map(f => patch[f]);
      params.push(id);
      const sql = `UPDATE scans SET ${fields.map((f, i) => `${f} = $${i + 1}`).join(', ')}
                   WHERE id = $${params.length} RETURNING *`;
      const { rows } = await pool.query(sql, params);
      return rows[0];
    },
    async find(id) {
      const { rows } = await pool.query('SELECT * FROM scans WHERE id = $1', [id]);
      return rows[0] || null;
    },
    async latestSuccessful() {
      const { rows } = await pool.query(
        "SELECT * FROM scans WHERE status = 'success' ORDER BY id DESC LIMIT 1");
      return rows[0] || null;
    },
    async list(limit = 50) {
      const { rows } = await pool.query(
        'SELECT * FROM scans ORDER BY id DESC LIMIT $1', [limit]);
      return rows;
    },
  },

  scanResults: {
    async insertMany(scanId, rows) {
      if (!rows.length) return 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const r of rows) {
          await client.query(
            `INSERT INTO scan_results
               (scan_id, campus_id, hostel_id, room_id, bed_space_id, status, raw)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [scanId, r.campus_id || null, r.hostel_id || null,
             r.room_id || null, r.bed_space_id || null,
             r.status || 'unknown',
             r.raw ? JSON.stringify(r.raw) : null]);
        }
        await client.query('COMMIT');
        return rows.length;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async byScan(scanId) {
      const { rows } = await pool.query(
        'SELECT * FROM scan_results WHERE scan_id = $1', [scanId]);
      return rows;
    },
  },

  protectedSpaces: {
    async all(filter = {}) {
      const where = [];
      const params = [];
      if (filter.status)     { params.push(filter.status);    where.push(`status = $${params.length}`); }
      if (filter.hostelId)   { params.push(filter.hostelId);  where.push(`hostel_id = $${params.length}`); }
      if (filter.activeOnly) { where.push('released_at IS NULL'); }
      let sql = 'SELECT * FROM protected_spaces';
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY id DESC';
      const { rows } = await pool.query(sql, params);
      return rows;
    },
    async byBed(bedSpaceId) {
      const { rows } = await pool.query(
        'SELECT * FROM protected_spaces WHERE bed_space_id = $1 AND released_at IS NULL',
        [bedSpaceId]);
      return rows[0] || null;
    },
    async create(p) {
      const { rows } = await pool.query(
        `INSERT INTO protected_spaces
           (bed_space_id, room_id, hostel_id, campus_id, status, holder_name, holder_ref, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [p.bed_space_id, p.room_id || null, p.hostel_id || null,
         p.campus_id || null, p.status, p.holder_name || null,
         p.holder_ref || null, p.notes || null]);
      return rows[0];
    },
    async release(id) {
      const { rows } = await pool.query(
        'UPDATE protected_spaces SET released_at = NOW() WHERE id = $1 RETURNING *',
        [id]);
      return rows[0];
    },
    async update(id, patch) {
      const fields = Object.keys(patch);
      if (!fields.length) return null;
      const params = fields.map(f => patch[f]);
      params.push(id);
      const sql = `UPDATE protected_spaces SET ${fields.map((f, i) => `${f} = $${i + 1}`).join(', ')}
                   WHERE id = $${params.length} RETURNING *`;
      const { rows } = await pool.query(sql, params);
      return rows[0];
    },
    async activeCount() {
      const { rows } = await pool.query(
        'SELECT COUNT(*)::int AS c FROM protected_spaces WHERE released_at IS NULL');
      return rows[0].c;
    },
  },

  settings: {
    async all() {
      const { rows } = await pool.query('SELECT key, value FROM settings');
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    async get(key) {
      const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
      return rows[0] ? rows[0].value : undefined;
    },
    async set(key, value) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value)]);
    },
  },
};

// ===========================================================================
// 7. security/credential-store.js — AES-256-GCM at rest
// ===========================================================================
const credentialStore = (() => {
  function getKey() {
    // In production CREDENTIAL_KEY is required (validated at boot).
    const envKey = process.env.CREDENTIAL_KEY;
    if (envKey) return crypto.createHash('sha256').update(envKey).digest();
    // Dev fallback: file-based key (never used in production because env is required)
    const KEY_FILE = path.join(DATA_DIR, '.cred-key');
    if (!fs.existsSync(KEY_FILE)) {
      fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
    }
    return fs.readFileSync(KEY_FILE);
  }
  function encrypt(plain) {
    const key = getKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }
  function decrypt(payload) {
    if (!payload) return '';
    try {
      const buf = Buffer.from(payload, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch (e) {
      logger.error('Credential decrypt failed', { err: e.message });
      return '';
    }
  }
  return {
    async setPortalCredentials(username, password) {
      await repos.settings.set('portal.username', username || '');
      await repos.settings.set('portal.password.enc', password ? encrypt(password) : '');
    },
    async getPortalUsername() {
      const stored = await repos.settings.get('portal.username');
      return stored || process.env.PORTAL_USER || '';
    },
    async hasPortalCredentials() {
      const u = (await repos.settings.get('portal.username')) || process.env.PORTAL_USER;
      const p = (await repos.settings.get('portal.password.enc')) || process.env.PORTAL_PASS;
      return !!(u && p);
    },
    async _getPortalPassword() {
      const stored = await repos.settings.get('portal.password.enc');
      if (stored) return decrypt(stored);
      return process.env.PORTAL_PASS || '';
    },
  };
})();

// ===========================================================================
// 8. scanner/ — Portal automation
// ===========================================================================

// --- result-parser -------------------------------------------------------
const resultParser = {
  parse(rawObservations) {
    if (!Array.isArray(rawObservations)) return [];
    return rawObservations.map(o => ({
      campus_id: o.campus_id || null,
      hostel_id: o.hostel_id || null,
      room_id: o.room_id || null,
      bed_space_id: o.bed_space_id || null,
      status: o.available === true ? 'available'
            : o.available === false ? 'occupied'
            : 'unknown',
      raw: o.raw || o,
    }));
  },
};

// --- portal-client -------------------------------------------------------
const portalClient = (() => {
  let browser = null;
  let loginPage = null;

  async function launch() {
    if (!puppeteer) throw new Error('puppeteer not installed — portal automation unavailable');
    if (browser) return browser;
    const headless = (await repos.settings.get('scanner.headless')) === 'true';
    browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: [
        '--disable-gpu',
        '--disable-extensions',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
        '--no-zygote',
      ],
    });
    logger.info('Portal browser launched', { headless });
    return browser;
  }

  async function close() {
    if (browser) { await browser.close(); browser = null; loginPage = null; }
  }

  async function login() {
    const username = await credentialStore.getPortalUsername();
    const password = await credentialStore._getPortalPassword();
    if (!username || !password) {
      throw new Error('Portal credentials not configured. Set PORTAL_USER / PORTAL_PASS or use /api/settings/portal-credentials.');
    }

    const baseURL = (await repos.settings.get('portal.baseURL')) || process.env.BIU_PORTAL_URL || 'https://portal.biu.edu.ng';
    const loginPath = (await repos.settings.get('portal.loginPath')) || '/Students/Login';
    const waitTimeout = parseInt((await repos.settings.get('scanner.timeoutMs')) || '60000', 10);

    const b = await launch();
    const page = await b.newPage();
    await page.setDefaultTimeout(waitTimeout);
    await page.setViewport({ width: 1280, height: 800 });

    try {
      logger.info('Navigating to portal login', { url: baseURL + loginPath });
      await page.goto(baseURL + loginPath, { waitUntil: 'networkidle2', timeout: waitTimeout });

      await page.waitForSelector('#Username', { timeout: waitTimeout });
      await page.type('#Username', username, { delay: 25 });
      await page.type('#Password', password, { delay: 25 });
      await page.click("button[type='submit']");

      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: waitTimeout });
      logger.info('Portal login successful');
      loginPage = page;
      return page;
    } catch (err) {
      await page.close().catch(() => {});
      logger.error('Portal login failed', { err: err.message });
      throw err;
    }
  }

  return { launch, close, login, isAvailable: () => !!puppeteer };
})();

// --- hostel-scanner ------------------------------------------------------
const hostelScanner = (() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randomMs = ([min, max]) => Math.floor(Math.random() * (max - min + 1)) + min;
  const dedupe = (arr) => [...new Set(arr)];

  async function safeRun(fn, retries = 6) {
    for (let i = 1; i <= retries; i++) {
      try { return await fn(); }
      catch (e) {
        if (i === retries) throw e;
        await sleep(250);
      }
    }
    return null;
  }

  async function waitForSelectOptions(page, selector, minCount = 1, timeout = 15000) {
    return await safeRun(async () => {
      await page.waitForSelector(selector, { timeout });
      await sleep(500);
      const options = await page.$$eval(`${selector} option`, opts =>
        opts.map(o => o.textContent.trim()));
      const valid = options.filter(t => t && !/^select|^choose|^--/i.test(t));
      const unique = dedupe(valid);
      if (unique.length >= minCount) return unique;
      throw new Error(`Options not loaded (${unique.length}/${minCount}) for ${selector}`);
    });
  }

  async function getOptionsSignature(page, selector) {
    try {
      return await page.$$eval(`${selector} option`, opts =>
        opts.map(o => o.textContent.trim()).join('|'));
    } catch { return ''; }
  }

  async function waitForNewOptions(page, selector, prevSig, timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const sig = await getOptionsSignature(page, selector);
      if (sig && sig !== prevSig && sig.replace(/\|/g, '').length > 0) return true;
      await sleep(300);
    }
    return false;
  }

  async function clearDropdown(page, selector) {
    try {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.innerHTML = '<option value="">-- Select --</option>';
        el.value = '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, selector);
    } catch { /* ignore */ }
  }

  async function selectDropdownOption(page, selector, optionText) {
    return await safeRun(async () => {
      await page.waitForSelector(selector, { timeout: 10000 });
      const foundValue = await page.$$eval(`${selector} option`, (opts, text) => {
        for (const opt of opts) {
          if (opt.textContent.trim() === text) return opt.value;
        }
        return null;
      }, optionText);
      if (foundValue === null) return false;
      await page.evaluate((sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, selector, foundValue);
      await sleep(800);
      return true;
    });
  }

  function looksStale(floorName, rooms) {
    if (/^FLAT\s+\d+$/i.test(floorName)) {
      const allFlatStyle = rooms.every(r => /^ROOM\s+\d+/i.test(r) || /SPORTS ROOM/i.test(r));
      if (!allFlatStyle) return true;
      if (rooms.length > 8) return true;
    }
    if (/FLOOR/i.test(floorName)) {
      const anyFlatStyle = rooms.some(r => /^ROOM\s+\d+/i.test(r));
      const looksLikeBxx  = rooms.some(r => /^B\d+$/i.test(r));
      if (looksLikeBxx && !anyFlatStyle) return true;
      if (rooms.length > 30) return true;
    }
    return false;
  }

  async function readBedSpaces(page, ctx, roomKey) {
    return await safeRun(async () => {
      await page.waitForSelector('#BedSpaceId', { timeout: 10000 });
      await sleep(500);

      const beds = await page.$$eval('#BedSpaceId option', (opts) => {
        const out = [];
        const seen = new Set();
        for (const opt of opts) {
          const name = opt.textContent.trim();
          if (!name || /^select|^--/i.test(name)) continue;
          if (seen.has(name)) continue;
          seen.add(name);
          out.push({ name, enabled: !opt.disabled });
        }
        return out;
      });

      const observations = [];
      for (const bed of beds) {
        const bedId = `${roomKey}::${bed.name}`.replace(/\s+/g, '_');
        observations.push({
          campus_id: ctx.campusId,
          hostel_id: ctx.hostelId,
          room_id: roomKey,
          bed_space_id: bedId,
          available: bed.enabled,
          raw: { bedLabel: bed.name, enabled: bed.enabled, hostelName: ctx.hostelName, unitName: ctx.unitName, roomName: ctx.roomName },
        });
      }
      return observations;
    });
  }

  async function scanHostel(page, { campusId, hostelName, hostelId, onProgress }) {
    const baseURL = (await repos.settings.get('portal.baseURL')) || process.env.BIU_PORTAL_URL || 'https://portal.biu.edu.ng';
    const hostelPath = (await repos.settings.get('portal.hostelPath')) || '/Students/Hostels';

    logger.info(`Scanning hostel: ${hostelName}`);
    const observations = [];

    await safeRun(async () => {
      await page.goto(baseURL + hostelPath, { waitUntil: 'networkidle2' });
      await sleep(1000);
    });

    await clearDropdown(page, '#FloorId');
    await clearDropdown(page, '#RoomId');
    await clearDropdown(page, '#BedSpaceId');

    const hostelOk = await selectDropdownOption(page, '#HostelId', hostelName);
    if (!hostelOk) {
      logger.warn('Could not select hostel on portal', { hostelName });
      return observations;
    }
    logger.info(`Selected hostel: ${hostelName}`);
    await sleep(1000);

    let floors = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        floors = await waitForSelectOptions(page, '#FloorId', 1, 10000);
        if (floors && floors.length) break;
      } catch {
        logger.warn(`Waiting for floors on ${hostelName} (attempt ${attempt})`);
        await sleep(2000);
      }
    }
    if (!floors || !floors.length) {
      logger.warn(`No floors found for ${hostelName}`);
      return observations;
    }
    logger.info(`Hostel ${hostelName}: ${floors.length} unit(s) → ${floors.join(', ')}`);

    for (const unitName of floors) {
      logger.info(`  Unit ${unitName}`);
      if (onProgress) onProgress({ hostelName, unitName });

      const beforeRoomSig = await getOptionsSignature(page, '#RoomId');
      await clearDropdown(page, '#RoomId');
      await clearDropdown(page, '#BedSpaceId');
      await sleep(300);

      const floorOk = await selectDropdownOption(page, '#FloorId', unitName);
      if (!floorOk) { logger.warn(`Could not select unit ${unitName}`); continue; }

      const changed = await waitForNewOptions(page, '#RoomId', beforeRoomSig, 15000);
      if (!changed) await sleep(1500);

      let rooms = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          rooms = await waitForSelectOptions(page, '#RoomId', 1, 10000);
          if (rooms && rooms.length) break;
        } catch {
          await sleep(2000);
        }
      }
      if (!rooms || !rooms.length) {
        logger.warn(`No rooms for ${hostelName} / ${unitName}`);
        continue;
      }

      if (looksStale(unitName, rooms)) {
        logger.warn(`Suspicious room list for ${hostelName}/${unitName} — skipping`);
        continue;
      }

      logger.info(`    ${rooms.length} room(s) on ${unitName}`);

      for (const roomName of rooms) {
        const roomKey = `${hostelId}::${unitName}::${roomName}`;

        await clearDropdown(page, '#BedSpaceId');
        await sleep(200);

        const roomOk = await selectDropdownOption(page, '#RoomId', roomName);
        if (!roomOk) { logger.warn(`Could not select room ${roomName}`); continue; }

        await sleep(700);

        const roomObs = await readBedSpaces(page, {
          campusId, hostelId, hostelName, unitName, roomName,
        }, roomKey);

        if (roomObs && roomObs.length) {
          observations.push(...roomObs);
          const avail = roomObs.filter(o => o.available).length;
          logger.info(`      ${roomName}: ${avail} available of ${roomObs.length}`);
        }

        await sleep(randomMs([200, 400]));
      }
    }

    logger.info(`Finished hostel ${hostelName}`, { observations: observations.length });
    return observations;
  }

  return { scanHostel };
})();

// --- scan-queue ----------------------------------------------------------
const scanQueue = (() => {
  const queue = [];
  const running = new Set();
  const cancelled = new Set();

  function enqueue(job) {
    queue.push(job);
    logger.info('Scan job queued', { scanId: job.scanId });
    process.nextTick(drain);
  }

  async function cancel(scanId) {
    if (running.has(scanId)) {
      cancelled.add(scanId);
      logger.warn('Scan cancellation requested', { scanId });
      return true;
    }
    const idx = queue.findIndex(j => j.scanId === scanId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      await repos.scans.update(scanId, { status: 'cancelled', finished_at: new Date() });
      logger.info('Queued scan cancelled before start', { scanId });
      return true;
    }
    return false;
  }

  async function drain() {
    const maxConcurrent = parseInt((await repos.settings.get('scanner.maxConcurrent')) || '1', 10);
    while (queue.length && running.size < maxConcurrent) {
      const job = queue.shift();
      running.add(job.scanId);
      job.run()
        .catch(err => logger.error('Scan job crashed', { scanId: job.scanId, err: err.message }))
        .finally(() => {
          running.delete(job.scanId);
          cancelled.delete(job.scanId);
          drain();
        });
    }
  }

  return {
    enqueue, cancel,
    isCancelled: (scanId) => cancelled.has(scanId),
    status: () => ({ queued: queue.map(j => j.scanId), running: Array.from(running) }),
  };
})();

// ===========================================================================
// 9. services/
// ===========================================================================

// --- scanner.service -----------------------------------------------------
const scannerService = {
  async startScan({ scope, campusId, hostelId }) {
    const scan = await repos.scans.create({
      scope: scope || 'full',
      campus_id: campusId || null,
      hostel_id: hostelId || null,
    });
    scanQueue.enqueue({
      scanId: scan.id,
      run: () => scannerService._execute(scan.id, { scope, campusId, hostelId }),
    });
    return scan;
  },

  async _execute(scanId, { scope, campusId, hostelId }) {
    await repos.scans.update(scanId, { status: 'running' });
    logger.info('Scan started', { scanId, scope, campusId, hostelId });

    let page = null;
    let allObservations = [];
    let roomsScanned = 0;

    try {
      const flat = flattenHostelConfig();
      let targets = flat;
      if (scope === 'campus' && campusId) {
        targets = targets.filter(h => h.campusId === String(campusId).toLowerCase());
      } else if (scope === 'hostel' && hostelId) {
        targets = targets.filter(h =>
          h.hostelId === hostelId || String(h.portalId) === String(hostelId));
      }
      if (!targets.length) throw new Error('No matching hostels for scan scope');

      page = await portalClient.login();

      for (const t of targets) {
        if (scanQueue.isCancelled(scanId)) {
          await repos.scans.update(scanId, { status: 'cancelled', finished_at: new Date() });
          logger.warn('Scan cancelled mid-run', { scanId });
          return;
        }

        const obs = await hostelScanner.scanHostel(page, {
          campusId: t.campusId,
          hostelId: t.hostelId,
          hostelName: t.hostelName,
          onProgress: ({ unitName }) =>
            logger.debug('Progress', { scanId, hostel: t.hostelName, unit: unitName }),
        });

        const uniqueRooms = new Set(obs.map(o => o.room_id));
        roomsScanned += uniqueRooms.size;
        allObservations = allObservations.concat(obs);

        const wait = 700 + Math.floor(Math.random() * 900);
        await new Promise(r => setTimeout(r, wait));
      }

      const parsed = resultParser.parse(allObservations);
      await repos.scanResults.insertMany(scanId, parsed);

      const available = parsed.filter(p => p.status === 'available').length;
      const occupied  = parsed.filter(p => p.status === 'occupied').length;

      await repos.scans.update(scanId, {
        status: 'success',
        finished_at: new Date(),
        available_count: available,
        occupied_count: occupied,
        rooms_scanned: roomsScanned,
      });
      logger.info('Scan completed', { scanId, available, occupied, roomsScanned });
    } catch (err) {
      // Preserve last successful snapshot — only mark THIS scan failed
      await repos.scans.update(scanId, {
        status: 'failed',
        finished_at: new Date(),
        error: err.message,
      });
      logger.error('Scan failed', { scanId, err: err.message });
    } finally {
      if (page) await page.close().catch(() => {});
    }
  },

  async progress(scanId) {
    const scan = await repos.scans.find(scanId);
    if (!scan) return null;
    return { scan, queue: scanQueue.status() };
  },

  cancel(scanId) { return scanQueue.cancel(scanId); },
};

// --- inventory.service ---------------------------------------------------
const inventoryService = {
  async buildView({ campusId, hostelId } = {}) {
    const latest = await repos.scans.latestSuccessful();
    const snapshot = latest ? await repos.scanResults.byScan(latest.id) : [];
    const snapshotByBed = new Map(snapshot.map(s => [s.bed_space_id, s]));

    const allocations = await repos.allocations.active();
    const allocByBed = new Map(allocations.map(a => [a.bed_space_id, a]));

    const protectedList = await repos.protectedSpaces.all({ activeOnly: true });
    const protectedByBed = new Map(protectedList.map(p => [p.bed_space_id, p]));

    const flat = flattenHostelConfig();
    const result = [];

    for (const h of flat) {
      if (campusId && h.campusId !== String(campusId).toLowerCase()) continue;
      if (hostelId && h.hostelId !== hostelId && String(h.portalId) !== String(hostelId)) continue;

      const hostelView = {
        campusId: h.campusId, campusName: h.campusName,
        hostelId: h.hostelId, hostelName: h.hostelName,
        gender: h.gender, structure: h.structure, portalId: h.portalId,
        units: [],
        totals: { available: 0, occupied: 0, held: 0, unknown: 0, allocated: 0 },
      };

      for (const unit of h.units) {
        const unitView = { unitId: unit.unitId, unitName: unit.unitName, rooms: [] };
        for (const roomName of unit.rooms) {
          const roomId = `${h.hostelId}-${unit.unitId}-${roomName}`.replace(/\s+/g, '_');
          const roomView = { roomId, roomName, beds: [] };

          for (let i = 1; i <= h.bedsPerRoom; i++) {
            const bedId = `${roomId}-B${i}`;
            const scanKey = `${h.hostelId}::${unit.unitId}::${roomName}::Bed_${i}`.replace(/\s+/g, '_');
            const snap = snapshotByBed.get(bedId) || snapshotByBed.get(scanKey);
            const alloc = allocByBed.get(bedId);
            const prot = protectedByBed.get(bedId);

            let status;
            if (prot) status = 'held';
            else if (alloc) status = 'allocated';
            else if (snap) status = snap.status;
            else status = 'unknown';

            roomView.beds.push({
              bedSpaceId: bedId,
              label: `Bed ${i}`,
              status,
              protectedInfo: prot ? { status: prot.status, holderName: prot.holder_name, notes: prot.notes } : null,
              allocationInfo: alloc ? { reference: alloc.reference } : null,
              lastSeenAt: latest ? latest.finished_at : null,
            });

            if (status === 'available')       hostelView.totals.available++;
            else if (status === 'occupied')   hostelView.totals.occupied++;
            else if (status === 'held')       hostelView.totals.held++;
            else if (status === 'allocated')  hostelView.totals.allocated++;
            else                              hostelView.totals.unknown++;
          }
          unitView.rooms.push(roomView);
        }
        hostelView.units.push(unitView);
      }
      result.push(hostelView);
    }

    return {
      generatedAt: dates.now(),
      lastSuccessfulScan: latest ? {
        id: latest.id, finished_at: latest.finished_at,
        available_count: latest.available_count,
        occupied_count: latest.occupied_count,
        rooms_scanned: latest.rooms_scanned,
      } : null,
      hostels: result,
    };
  },
};

// --- allocation.service --------------------------------------------------
const allocationService = {
  async allocate({ studentId, campusId, hostelId, roomId, bedSpaceId, reference }) {
    if (!studentId || !bedSpaceId) throw new Error('studentId and bedSpaceId are required');
    const existing = await repos.allocations.byBed(bedSpaceId);
    if (existing) throw new Error(`Bed ${bedSpaceId} already allocated`);
    const prot = await repos.protectedSpaces.byBed(bedSpaceId);
    if (prot) throw new Error(`Bed ${bedSpaceId} is protected (${prot.status})`);

    return repos.allocations.create({
      student_id: studentId, campus_id: campusId, hostel_id: hostelId,
      room_id: roomId, bed_space_id: bedSpaceId, reference: reference || null,
    });
  },
  lookupByStudent(studentId) { return repos.allocations.byStudent(studentId); },
};

// --- protected-spaces.service --------------------------------------------
const protectedSpacesService = {
  async create({ bedSpaceId, roomId, hostelId, campusId, status, holderName, holderRef, notes }) {
    if (!bedSpaceId) throw new Error('bedSpaceId is required');
    const allowed = ['reserved', 'held', 'payment_pending'];
    if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join(', ')}`);
    if (await repos.protectedSpaces.byBed(bedSpaceId)) {
      throw new Error(`Bed ${bedSpaceId} is already protected`);
    }
    return repos.protectedSpaces.create({
      bed_space_id: bedSpaceId, room_id: roomId, hostel_id: hostelId,
      campus_id: campusId, status, holder_name: holderName,
      holder_ref: holderRef, notes,
    });
  },
  list(filter) { return repos.protectedSpaces.all(filter); },
  update(id, patch) { return repos.protectedSpaces.update(id, patch); },
  release(id) { return repos.protectedSpaces.release(id); },
};

// --- scan-history.service ------------------------------------------------
const scanHistoryService = {
  list(limit = 50) { return repos.scans.list(limit); },
  async detail(scanId) {
    const scan = await repos.scans.find(scanId);
    if (!scan) return null;
    const results = await repos.scanResults.byScan(scanId);
    return { scan, results };
  },
  lastSuccessful() { return repos.scans.latestSuccessful(); },
};

// --- report.service ------------------------------------------------------
const reportService = {
  async summary() {
    const scans = await repos.scans.list(1000);
    const success = scans.filter(s => s.status === 'success').length;
    const failed  = scans.filter(s => s.status === 'failed').length;
    return {
      totalScans: scans.length,
      successfulScans: success,
      failedScans: failed,
      lastSuccessfulScan: await repos.scans.latestSuccessful(),
      protectedActive: await repos.protectedSpaces.activeCount(),
      generatedAt: dates.now(),
    };
  },
  async trend(days = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const scans = (await repos.scans.list(1000))
      .filter(s => new Date(s.started_at).toISOString() >= cutoff);
    const byDay = {};
    for (const s of scans) {
      const day = new Date(s.started_at).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { day, available: 0, occupied: 0, scans: 0 };
      byDay[day].available += s.available_count || 0;
      byDay[day].occupied  += s.occupied_count  || 0;
      byDay[day].scans     += 1;
    }
    return Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  },
  async hostelComparison() {
    const view = await inventoryService.buildView();
    return view.hostels.map(h => ({
      hostelId: h.hostelId, hostelName: h.hostelName,
      campusName: h.campusName, gender: h.gender,
      ...h.totals,
    }));
  },
};

// --- export.service ------------------------------------------------------
const exportService = {
  toCSV(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const escape = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
  },
  writeReport(name, rows) {
    const filename = `${name}-${Date.now()}.csv`;
    const full = path.join(EXPORT_DIR, filename);
    fs.writeFileSync(full, this.toCSV(rows), 'utf8');
    logger.info('Report exported', { file: filename });
    return { filename, path: full };
  },
};

// --- settings.service ----------------------------------------------------
const settingsService = {
  async getAll(redactSecrets = true) {
    const all = await repos.settings.all();
    if (!redactSecrets) return all;
    const safe = { ...all };
    delete safe['portal.password.enc'];
    safe['portal.passwordSet'] = !!all['portal.password.enc'];
    safe['portal.username'] = all['portal.username'] || process.env.PORTAL_USER || '';
    return safe;
  },
  async update(patch) {
    const allowed = [
      'app.name',
      'scanner.headless', 'scanner.timeoutMs', 'scanner.maxConcurrent',
      'scanner.retryCount', 'scanner.randomDelayMin', 'scanner.randomDelayMax',
      'portal.baseURL', 'portal.loginPath', 'portal.hostelPath',
      'backup.retentionDays', 'backup.autoEnabled',
    ];
    for (const [k, v] of Object.entries(patch || {})) {
      if (allowed.includes(k)) await repos.settings.set(k, v);
    }
    return this.getAll();
  },
  async updatePortalCredentials(username, password) {
    await credentialStore.setPortalCredentials(username, password);
    return { username, passwordSet: !!password };
  },
  async testPortalConnection() {
    return {
      configured: await credentialStore.hasPortalCredentials(),
      username: (await credentialStore.getPortalUsername()) || null,
      baseURL: (await repos.settings.get('portal.baseURL')) || process.env.BIU_PORTAL_URL,
      puppeteerAvailable: portalClient.isAvailable(),
    };
  },
};

// --- backup.service (Postgres-aware) -------------------------------------
const backupService = {
  /**
   * For Postgres, "backup" means a logical dump via pg_dump-style query.
   * In production, use Supabase's built-in daily backups instead of this.
   * Here we return a lightweight JSON snapshot of the core tables.
   */
  async createBackup() {
    const tables = ['users', 'campuses', 'hostels', 'rooms', 'bed_spaces',
                    'students', 'allocations', 'scans', 'scan_results',
                    'protected_spaces', 'settings'];
    const snapshot = {};
    for (const t of tables) {
      const { rows } = await pool.query(`SELECT * FROM ${t}`);
      snapshot[t] = rows;
    }
    const filename = `backup-${Date.now()}.json`;
    const full = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(full, JSON.stringify(snapshot, null, 2), 'utf8');
    logger.info('Backup created', { file: filename });
    return { filename, path: full, sizeBytes: fs.statSync(full).size };
  },
  listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    });
  },
};

// ===========================================================================
// 10. middleware
// ===========================================================================
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Authentication required' });
}

const validate = {
  body(schema) {
    return (req, res, next) => {
      const errors = [];
      for (const [field, rule] of Object.entries(schema)) {
        const value = req.body ? req.body[field] : undefined;
        if (rule.required && (value === undefined || value === null || value === '')) {
          errors.push(`${field} is required`); continue;
        }
        if (value === undefined) continue;
        if (rule.type === 'string' && typeof value !== 'string') errors.push(`${field} must be a string`);
        if (rule.type === 'number' && typeof value !== 'number') errors.push(`${field} must be a number`);
        if (rule.type === 'boolean' && typeof value !== 'boolean') errors.push(`${field} must be a boolean`);
        if (rule.enum && !rule.enum.includes(value)) errors.push(`${field} must be one of: ${rule.enum.join(', ')}`);
      }
      if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
      next();
    };
  },
};

function errorHandler(err, req, res, _next) {
  logger.error('Unhandled error', { path: req.path, method: req.method, err: err.message });
  const status = err.status || 500;
  const message = status >= 500 && IS_PROD
    ? 'Internal server error'
    : err.message || 'Internal server error';
  res.status(status).json({ error: message });
}

const asyncWrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ===========================================================================
// 11. Express app
// ===========================================================================
function createApp() {
  const app = express();

  app.set('trust proxy', 1); // Render sits behind a proxy — needed for secure cookies

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ---- CORS (Vercel → Render) ----
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });

  // ---- Sessions (Postgres-backed) ----
  app.use(session({
    store: new pgSession({ pool, tableName: 'session' }),
    name: 'hsf.sid',
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: IS_PROD ? 'none' : 'lax',  // cross-origin Vercel → Render
      secure: IS_PROD,                     // required for sameSite:'none'
      maxAge: 1000 * 60 * 60 * 8,
    },
  }));

  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Health ----
  app.get('/api/health', asyncWrap(async (req, res) => {
    let dbOk = false;
    try { await pool.query('SELECT 1'); dbOk = true; } catch { /* noop */ }
    res.json({
      ok: true, env: NODE_ENV, time: dates.now(),
      db: dbOk ? 'postgres' : 'unavailable',
      puppeteer: portalClient.isAvailable(),
    });
  }));

  // ---- Auth ----
  app.post('/api/auth/login',
    validate.body({ username: { required: true, type: 'string' }, password: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) => {
      const { username, password } = req.body;
      const user = await repos.users.findByUsername(username);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      logger.info('User logged in', { username });
      res.json({ user: { id: user.id, username: user.username, role: user.role } });
    })
  );

  app.get('/api/auth/session', (req, res) => {
    if (req.session && req.session.userId) {
      return res.json({ authenticated: true, user: { id: req.session.userId, username: req.session.username } });
    }
    res.json({ authenticated: false });
  });

  app.get('/api/auth/me', requireAuth, asyncWrap(async (req, res) => {
    const user = await repos.users.findById(req.session.userId);
    res.json({ user });
  }));

  app.post('/api/auth/logout', (req, res) => {
    const username = req.session && req.session.username;
    req.session.destroy(() => {
      logger.info('User logged out', { username });
      res.clearCookie('hsf.sid');
      res.json({ ok: true });
    });
  });

  // ---- Protected API ----
  const api = express.Router();
  api.use(requireAuth);

  // ---- Dashboard ----
  api.get('/dashboard', asyncWrap(async (req, res) => {
    const latest = await repos.scans.latestSuccessful();
    const view = await inventoryService.buildView();
    const totals = view.hostels.reduce((acc, h) => {
      for (const k of Object.keys(h.totals)) acc[k] = (acc[k] || 0) + h.totals[k];
      return acc;
    }, { available: 0, occupied: 0, held: 0, unknown: 0, allocated: 0 });

    res.json({
      appName: (await repos.settings.get('app.name')) || 'Hostel Space Finder',
      lastSuccessfulScan: latest,
      totals,
      hostelSummaries: view.hostels.map(h => ({
        hostelId: h.hostelId, hostelName: h.hostelName,
        campusName: h.campusName, gender: h.gender,
        totals: h.totals,
      })),
      recentScans: await repos.scans.list(10),
      protectedActive: await repos.protectedSpaces.activeCount(),
      generatedAt: dates.now(),
    });
  }));

  // ---- Scanner ----
  api.post('/scanner/start',
    validate.body({ scope: { type: 'string', enum: ['full', 'campus', 'hostel'] } }),
    asyncWrap(async (req, res) => {
      const { scope = 'full', campusId, hostelId } = req.body || {};
      if (scope === 'campus' && !campusId) return res.status(400).json({ error: 'campusId required' });
      if (scope === 'hostel' && !hostelId) return res.status(400).json({ error: 'hostelId required' });
      const scan = await scannerService.startScan({ scope, campusId, hostelId });
      res.status(202).json({ scan });
    })
  );
  api.get('/scanner/progress/:scanId', asyncWrap(async (req, res) => {
    const p = await scannerService.progress(parseInt(req.params.scanId, 10));
    if (!p) return res.status(404).json({ error: 'Scan not found' });
    res.json(p);
  }));
  api.get('/scanner/result/:scanId', asyncWrap(async (req, res) => {
    const d = await scanHistoryService.detail(parseInt(req.params.scanId, 10));
    if (!d) return res.status(404).json({ error: 'Scan not found' });
    res.json(d);
  }));
  api.post('/scanner/cancel/:scanId', asyncWrap(async (req, res) => {
    res.json({ cancelled: await scannerService.cancel(parseInt(req.params.scanId, 10)) });
  }));
  api.get('/scanner/queue', (req, res) => res.json(scanQueue.status()));
  api.get('/scanner/errors', asyncWrap(async (req, res) => {
    const failed = (await repos.scans.list(50)).filter(s => s.status === 'failed');
    res.json({ failed });
  }));

  // ---- Inventory ----
  api.get('/inventory', asyncWrap(async (req, res) => {
    res.json(await inventoryService.buildView({
      campusId: req.query.campusId, hostelId: req.query.hostelId,
    }));
  }));
  api.get('/inventory/campuses', asyncWrap(async (req, res) =>
    res.json({ campuses: await repos.campuses.all() })));
  api.get('/inventory/hostels', asyncWrap(async (req, res) => {
    if (req.query.campusId) return res.json({ hostels: await repos.hostels.byCampus(req.query.campusId) });
    res.json({ hostels: await repos.hostels.all() });
  }));
  api.get('/inventory/rooms/:hostelId', asyncWrap(async (req, res) =>
    res.json({ rooms: await repos.rooms.byHostel(req.params.hostelId) })));
  api.get('/inventory/beds/:roomId', asyncWrap(async (req, res) =>
    res.json({ beds: await repos.beds.byRoom(req.params.roomId) })));

  // ---- Students ----
  api.get('/students', asyncWrap(async (req, res) => {
    const students = await repos.students.search({
      q: req.query.q, hostelId: req.query.hostelId,
      roomId: req.query.roomId, matric: req.query.matric,
    });
    const withAlloc = [];
    for (const s of students) {
      withAlloc.push({ ...s, allocations: await repos.allocations.byStudent(s.id) });
    }
    res.json({ students: withAlloc });
  }));
  api.post('/students',
    validate.body({ matric_number: { required: true, type: 'string' }, full_name: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) => res.status(201).json({ student: await repos.students.create(req.body) }))
  );
  api.post('/students/allocate',
    validate.body({ studentId: { required: true, type: 'number' }, bedSpaceId: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) => res.status(201).json({ allocation: await allocationService.allocate(req.body) }))
  );
  api.get('/students/:studentId/allocations', asyncWrap(async (req, res) =>
    res.json({ allocations: await allocationService.lookupByStudent(parseInt(req.params.studentId, 10)) })));

  // ---- Protected spaces ----
  api.get('/protected-spaces', asyncWrap(async (req, res) => {
    res.json({
      protectedSpaces: await protectedSpacesService.list({
        status: req.query.status, hostelId: req.query.hostelId,
        activeOnly: req.query.activeOnly !== 'false',
      }),
    });
  }));
  api.post('/protected-spaces',
    validate.body({
      bedSpaceId: { required: true, type: 'string' },
      status: { required: true, type: 'string', enum: ['reserved', 'held', 'payment_pending'] },
    }),
    asyncWrap(async (req, res) => res.status(201).json({ protectedSpace: await protectedSpacesService.create(req.body) }))
  );
  api.patch('/protected-spaces/:id', asyncWrap(async (req, res) => {
    const rec = await protectedSpacesService.update(parseInt(req.params.id, 10), req.body || {});
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ protectedSpace: rec });
  }));
  api.post('/protected-spaces/:id/release', asyncWrap(async (req, res) => {
    const rec = await protectedSpacesService.release(parseInt(req.params.id, 10));
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ protectedSpace: rec });
  }));

  // ---- History ----
  api.get('/history', asyncWrap(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    res.json({ scans: await scanHistoryService.list(limit) });
  }));
  api.get('/history/:scanId', asyncWrap(async (req, res) => {
    const d = await scanHistoryService.detail(parseInt(req.params.scanId, 10));
    if (!d) return res.status(404).json({ error: 'Scan not found' });
    res.json(d);
  }));

  // ---- Reports ----
  api.get('/reports/summary', asyncWrap(async (req, res) => res.json(await reportService.summary())));
  api.get('/reports/trend', asyncWrap(async (req, res) => {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 180);
    res.json({ days, trend: await reportService.trend(days) });
  }));
  api.get('/reports/hostels', asyncWrap(async (req, res) =>
    res.json({ hostels: await reportService.hostelComparison() })));
  api.get('/reports/export', asyncWrap(async (req, res) => {
    const type = req.query.type || 'inventory';
    let rows;
    if (type === 'inventory') rows = await reportService.hostelComparison();
    else if (type === 'history') rows = await scanHistoryService.list(1000);
    else if (type === 'protected') rows = await protectedSpacesService.list({ activeOnly: false });
    else return res.status(400).json({ error: 'Unknown report type' });
    const { filename } = exportService.writeReport(type, rows);
    res.json({ filename, downloadUrl: `/api/reports/download/${filename}` });
  }));
  api.get('/reports/download/:filename', (req, res) => {
    const filename = path.basename(req.params.filename);
    const full = path.join(EXPORT_DIR, filename);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
    res.download(full, filename);
  });

  // ---- Settings ----
  api.get('/settings', asyncWrap(async (req, res) =>
    res.json({ settings: await settingsService.getAll() })));
  api.patch('/settings', asyncWrap(async (req, res) =>
    res.json({ settings: await settingsService.update(req.body || {}) })));
  api.post('/settings/portal-credentials',
    validate.body({ username: { required: true, type: 'string' }, password: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) =>
      res.json(await settingsService.updatePortalCredentials(req.body.username, req.body.password))));
  api.post('/settings/portal-test', asyncWrap(async (req, res) =>
    res.json(await settingsService.testPortalConnection())));
  api.post('/settings/backup', asyncWrap(async (req, res) =>
    res.json(await backupService.createBackup())));
  api.get('/settings/backups', (req, res) =>
    res.json({ backups: backupService.listBackups() }));

  app.use('/api', api);

  // Fallback root
  app.get('/', (req, res) => {
    const loginPath = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(loginPath)) return res.sendFile(loginPath);
    res.json({
      message: 'Hostel Space Finder backend is running.',
      endpoints: ['/api/health', '/api/auth/login', '/api/dashboard', '/api/inventory', '/api/scanner/start'],
    });
  });

  app.use(errorHandler);
  return app;
}

// ===========================================================================
// 12. Bootstrap + graceful shutdown
// ===========================================================================
async function start() {
  ensureDirs();
  await initDatabase();

  const app = createApp();
  const server = app.listen(PORT, () => {
    logger.info('Hostel Space Finder server listening', {
      port: PORT, env: NODE_ENV,
    });
  });

  const shutdown = async (signal) => {
    logger.warn(`Received ${signal}, shutting down...`);
    server.close(async () => {
      try {
        await portalClient.close();
        await pool.end();
      } catch (e) { logger.error('Shutdown error', { err: e.message }); }
      logger.info('Server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) =>
    logger.error('Unhandled promise rejection', { reason: String(reason) }));
}

function ensureDirs() {
  for (const d of [DATA_DIR, BACKUP_DIR, EXPORT_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

if (require.main === module) start();

module.exports = { createApp, start, hostelConfig, flattenHostelConfig };