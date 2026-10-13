/**
 * Hostel Space Finder — Single-File Backend Server (v2)
 * ---------------------------------------------------------------------------
 * Rebuilt to integrate the real BIU portal automation from hostelChecker.js
 * and the real hostelConfig.js structure (Legacy / Heritage → boys / girls →
 * flats / floors → hostel).
 *
 * End-to-end pipeline:
 *   routes → scanner.service → scan-queue → portal-client (login)
 *          → hostel-scanner (drives Puppeteer exactly like hostelChecker.js)
 *          → result-parser → scan-history + inventory services → DB
 *
 * Run:  node server.js
 * Deps: express express-session better-sqlite3 bcryptjs puppeteer chalk
 * Env:  BIU_PORTAL_URL, PORTAL_USER, PORTAL_PASS, SESSION_SECRET, CREDENTIAL_KEY
 */

'use strict';

// ===========================================================================
// 0. IMPORTS
// ===========================================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

let Database;
try { Database = require('better-sqlite3'); } catch { Database = null; }

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

let chalk;
try { chalk = require('chalk'); } catch {
  // Fallback no-op colouring if chalk isn't installed
  const id = (s) => s;
  chalk = new Proxy({}, { get: () => id });
}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

const DATA_DIR   = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const DB_PATH    = path.join(DATA_DIR, 'hostel-space-finder.db');

// ===========================================================================
// 1. utils/logger.js — consistent logger (redacts secrets)
// ===========================================================================
const logger = (() => {
  const SENSITIVE = ['password', 'passwd', 'token', 'secret', 'authorization', 'cookie'];
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
    debug: (m, x) => NODE_ENV === 'development' && write('DEBUG', m, x),
  };
})();

// ===========================================================================
// 2. utils/dates.js
// ===========================================================================
const dates = {
  now:     () => new Date().toISOString(),
  today:   () => new Date().toISOString().slice(0, 10),
  daysAgo: (n) => new Date(Date.now() - n * 86400000).toISOString(),
  format:  (d) => new Date(d).toISOString(),
  range:   (from, to) => ({ from: dates.format(from), to: dates.format(to) }),
};

// ===========================================================================
// 3. config/hostelConfig.js — YOUR REAL CONFIG (verbatim shape)
// ===========================================================================
/**
 * Structure:
 *   hostelConfig[CampusName][boys|girls][flats|floors][HostelName] = {
 *     hostel_id,                    // numeric id used by the BIU portal
 *     flats: <n> | [flatNos],       // if flat-based
 *     roomsPerFlat: { default, exceptions },
 *     floors: ["A","B",...],        // if floor-based
 *     roomsPerFloor: <n> | { A: n, B: n },
 *     bedsPerRoom: <n>
 *   }
 */
const hostelConfig = {
  // ==================== LEGACY (OKHA) CAMPUS ====================
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

  // ==================== HERITAGE CAMPUS ====================
  Heritage: {
    boys: {
      floors: {
        "WISDOM BOYS HOSTEL": { hostel_id: 20, floors: ["A"], roomsPerFloor: { A: 12 }, bedsPerRoom: 4 },
        "PEACE HOSTEL":       { hostel_id: 21, floors: ["A", "B", "C", "D"], roomsPerFloor: { A: 13, B: 15, C: 15, D: 15 }, bedsPerRoom: 4 },
      },
      flats: {
        "VALOR HOSTEL":               { hostel_id: 18, flats: 9, roomsPerFlat: { default: 4 }, bedsPerRoom: 4 },
        "BISHOP'S COURT HOSTEL (MALE)": { hostel_id: 19, flats: 3, roomsPerFlat: { default: 4 }, bedsPerRoom: 4 },
      },
    },
    girls: {
      floors: {
        "FAITH HOSTEL":         { hostel_id: 12, floors: ["A", "B", "C", "D"], roomsPerFloor: { A: 16, B: 18, C: 16, D: 10 }, bedsPerRoom: 4 },
        "VIRTUE HOSTEL":        { hostel_id: 13, floors: ["E", "F", "G", "H"], roomsPerFloor: { E: 19, F: 19, G: 19, H: 12 }, bedsPerRoom: 4 },
        "WISDOM GIRLS HOSTEL":  { hostel_id: 14, floors: ["B", "C"],           roomsPerFloor: { B: 13, C: 13 },         bedsPerRoom: 4 },
        "AGAPE HOSTEL":         { hostel_id: 15, floors: ["A", "B", "C"],      roomsPerFloor: { A: 16, B: 16, C: 16 },  bedsPerRoom: 4 },
        "OVERCOMERS HOSTEL":    { hostel_id: 16, floors: ["A", "B", "C", "D"], roomsPerFloor: { A: 14, B: 16, C: 16, D: 16 }, bedsPerRoom: 4 },
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

// ---------------------------------------------------------------------------
// 3b. Adapters: flatten your nested config into the DB/inventory shape
// ---------------------------------------------------------------------------

/**
 * Yields a flat list of hostels from the nested hostelConfig.
 * Each entry: { campusId, campusName, gender, structure, hostelId,
 *               hostelName, portalId, units[], rooms[] }
 *   - structure is 'flats' or 'floors'
 *   - units[] are the flat numbers or floor letters as strings
 *   - rooms[] is generated from roomsPerFlat / roomsPerFloor
 */
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
              const rooms = Array.from({ length: roomCount }, (_, i) => `ROOM ${i + 1}`);
              units.push({ unitId: `FLAT ${fno}`, unitName: `Flat ${fno}`, rooms });
            }
          } else {
            const floors = def.floors || [];
            for (const fl of floors) {
              const roomCount =
                typeof def.roomsPerFloor === 'number'
                  ? def.roomsPerFloor
                  : (def.roomsPerFloor && def.roomsPerFloor[fl]) || 0;
              const rooms = Array.from({ length: roomCount }, (_, i) => `ROOM ${i + 1}`);
              units.push({ unitId: `${fl} FLOOR`, unitName: `${fl} Floor`, rooms });
            }
          }

          out.push({
            campusId: campusName.toLowerCase(),
            campusName,
            gender,
            structure,
            hostelId: `${campusName.toLowerCase()}-${hostelName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
            hostelName,
            portalId: def.hostel_id,
            bedsPerRoom: def.bedsPerRoom || 4,
            units,
          });
        }
      }
    }
  }
  return out;
}

function findHostelInConfig({ campusId, hostelId, hostelName }) {
  const all = flattenHostelConfig();
  return all.find(h =>
    (hostelId && h.hostelId === hostelId) ||
    (hostelName && h.hostelName.toUpperCase() === String(hostelName).toUpperCase()) ||
    (hostelId && h.portalId === hostelId) ||
    (campusId && h.campusId === String(campusId).toLowerCase() && !hostelId && !hostelName)
  ) || null;
}

// ===========================================================================
// 4. database/connection.js + migrations + seed
// ===========================================================================
function ensureDirs() {
  for (const d of [DATA_DIR, BACKUP_DIR, EXPORT_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

let db = null;

function initDatabase() {
  if (!Database) {
    logger.warn('better-sqlite3 not installed — using in-memory fallback.');
    return initMemoryStore();
  }
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations();
  seedInitialData();
  logger.info('SQLite database ready', { path: DB_PATH });
  return db;
}

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'admin',
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campuses (
      id   TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hostels (
      id             TEXT PRIMARY KEY,
      campus_id      TEXT NOT NULL,
      name           TEXT NOT NULL,
      gender         TEXT,
      structure      TEXT,
      portal_id      INTEGER,
      FOREIGN KEY (campus_id) REFERENCES campuses(id)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id         TEXT PRIMARY KEY,
      hostel_id  TEXT NOT NULL,
      parent_id  TEXT,
      name       TEXT NOT NULL,
      bed_spaces INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (hostel_id) REFERENCES hostels(id)
    );

    CREATE TABLE IF NOT EXISTS bed_spaces (
      id      TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      label   TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id)
    );

    CREATE TABLE IF NOT EXISTS students (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      matric_number  TEXT UNIQUE NOT NULL,
      full_name      TEXT NOT NULL,
      gender         TEXT,
      level          TEXT,
      department     TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS allocations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id   INTEGER NOT NULL,
      campus_id    TEXT,
      hostel_id    TEXT,
      room_id      TEXT,
      bed_space_id TEXT,
      reference    TEXT,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TEXT NOT NULL,
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS scans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at      TEXT NOT NULL,
      finished_at     TEXT,
      status          TEXT NOT NULL,
      scope           TEXT,
      campus_id       TEXT,
      hostel_id       TEXT,
      available_count INTEGER DEFAULT 0,
      occupied_count  INTEGER DEFAULT 0,
      rooms_scanned   INTEGER DEFAULT 0,
      error           TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_results (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id      INTEGER NOT NULL,
      campus_id    TEXT,
      hostel_id    TEXT,
      room_id      TEXT,
      bed_space_id TEXT,
      status       TEXT,
      raw          TEXT,
      FOREIGN KEY (scan_id) REFERENCES scans(id)
    );

    CREATE TABLE IF NOT EXISTS protected_spaces (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bed_space_id TEXT NOT NULL,
      room_id      TEXT,
      hostel_id    TEXT,
      campus_id    TEXT,
      status       TEXT NOT NULL,
      holder_name  TEXT,
      holder_ref   TEXT,
      notes        TEXT,
      created_at   TEXT NOT NULL,
      released_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scan_results_scan ON scan_results(scan_id);
    CREATE INDEX IF NOT EXISTS idx_allocations_student ON allocations(student_id);
    CREATE INDEX IF NOT EXISTS idx_protected_status ON protected_spaces(status);
    CREATE INDEX IF NOT EXISTS idx_scans_status ON scans(status);
  `);
  logger.info('Migrations applied.');
}

function seedInitialData() {
  const now = dates.now();

  // Seed campuses / hostels / rooms / beds from the real hostelConfig
  const insCampus = db.prepare('INSERT OR IGNORE INTO campuses (id, name) VALUES (?, ?)');
  const insHostel = db.prepare('INSERT OR IGNORE INTO hostels (id, campus_id, name, gender, structure, portal_id) VALUES (?, ?, ?, ?, ?, ?)');
  const insRoom   = db.prepare('INSERT OR IGNORE INTO rooms (id, hostel_id, parent_id, name, bed_spaces) VALUES (?, ?, ?, ?, ?)');
  const insBed    = db.prepare('INSERT OR IGNORE INTO bed_spaces (id, room_id, label) VALUES (?, ?, ?)');

  const flat = flattenHostelConfig();
  const seenCampuses = new Set();
  for (const h of flat) {
    if (!seenCampuses.has(h.campusId)) {
      insCampus.run(h.campusId, h.campusName);
      seenCampuses.add(h.campusId);
    }
    insHostel.run(h.hostelId, h.campusId, h.hostelName, h.gender, h.structure, h.portalId);
    for (const unit of h.units) {
      for (const roomName of unit.rooms) {
        const roomId = `${h.hostelId}-${unit.unitId}-${roomName}`.replace(/\s+/g, '_');
        insRoom.run(roomId, h.hostelId, unit.unitId, roomName, h.bedsPerRoom);
        for (let i = 1; i <= h.bedsPerRoom; i++) {
          insBed.run(`${roomId}-B${i}`, roomId, `Bed ${i}`);
        }
      }
    }
  }

  // Default admin
  if (!db.prepare('SELECT id FROM users WHERE username = ?').get('admin')) {
    db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
      .run('admin', bcrypt.hashSync('admin123', 10), 'admin', now);
    logger.warn('Seeded default admin (admin / admin123) — change in production!');
  }

  // Defaults
  const defaults = {
    'app.name': 'Hostel Space Finder',
    'scanner.headless': 'false',
    'scanner.timeoutMs': '60000',
    'scanner.maxConcurrent': '1',
    'scanner.retryCount': '6',
    'scanner.randomDelayMin': '700',
    'scanner.randomDelayMax': '1600',
    'portal.baseURL': process.env.BIU_PORTAL_URL || 'https://portal.biu.edu.ng',
    'portal.loginPath': '/Students/Login',
    'portal.hostelPath': '/Students/Hostels',
    'portal.username': '',
    'portal.password.enc': '',
    'backup.retentionDays': '30',
    'backup.autoEnabled': 'false',
  };
  const insSet = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaults)) insSet.run(k, v);

  logger.info('Seed data verified.', { hostels: flat.length });
}

// In-memory fallback -------------------------------------------------------
function initMemoryStore() {
  const store = {
    users: [], campuses: [], hostels: [], rooms: [], bed_spaces: [],
    students: [], allocations: [], scans: [], scan_results: [],
    protected_spaces: [], settings: {},
  };
  store.users.push({
    id: 1, username: 'admin',
    password_hash: bcrypt.hashSync('admin123', 10),
    role: 'admin', created_at: dates.now(),
  });
  const flat = flattenHostelConfig();
  const seen = new Set();
  for (const h of flat) {
    if (!seen.has(h.campusId)) {
      store.campuses.push({ id: h.campusId, name: h.campusName });
      seen.add(h.campusId);
    }
    store.hostels.push({
      id: h.hostelId, campus_id: h.campusId, name: h.hostelName,
      gender: h.gender, structure: h.structure, portal_id: h.portalId,
    });
    for (const unit of h.units) {
      for (const roomName of unit.rooms) {
        const roomId = `${h.hostelId}-${unit.unitId}-${roomName}`.replace(/\s+/g, '_');
        store.rooms.push({
          id: roomId, hostel_id: h.hostelId, parent_id: unit.unitId,
          name: roomName, bed_spaces: h.bedsPerRoom,
        });
        for (let i = 1; i <= h.bedsPerRoom; i++) {
          store.bed_spaces.push({ id: `${roomId}-B${i}`, room_id: roomId, label: `Bed ${i}` });
        }
      }
    }
  }
  db = { _memory: store };
  logger.info('In-memory store initialised.', { hostels: flat.length });
  return db;
}

const isMemory = () => db && db._memory;
const mem = () => db._memory;

// ===========================================================================
// 5. database/repositories/
// ===========================================================================
const repos = {
  users: {
    findByUsername(u) {
      if (isMemory()) return mem().users.find(x => x.username === u) || null;
      return db.prepare('SELECT * FROM users WHERE username = ?').get(u) || null;
    },
    findById(id) {
      if (isMemory()) {
        const r = mem().users.find(x => x.id === id);
        if (!r) return null;
        const { password_hash, ...safe } = r;
        return safe;
      }
      return db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?').get(id) || null;
    },
  },

  campuses: {
    all() {
      if (isMemory()) return mem().campuses;
      return db.prepare('SELECT * FROM campuses').all();
    },
  },
  hostels: {
    byCampus(campusId) {
      if (isMemory()) return mem().hostels.filter(h => h.campus_id === campusId);
      return db.prepare('SELECT * FROM hostels WHERE campus_id = ?').all(campusId);
    },
    find(id) {
      if (isMemory()) return mem().hostels.find(h => h.id === id) || null;
      return db.prepare('SELECT * FROM hostels WHERE id = ?').get(id) || null;
    },
    all() {
      if (isMemory()) return mem().hostels;
      return db.prepare('SELECT * FROM hostels').all();
    },
  },
  rooms: {
    byHostel(hostelId) {
      if (isMemory()) return mem().rooms.filter(r => r.hostel_id === hostelId);
      return db.prepare('SELECT * FROM rooms WHERE hostel_id = ?').all(hostelId);
    },
  },
  beds: {
    byRoom(roomId) {
      if (isMemory()) return mem().bed_spaces.filter(b => b.room_id === roomId);
      return db.prepare('SELECT * FROM bed_spaces WHERE room_id = ?').all(roomId);
    },
  },

  students: {
    search({ q, hostelId, roomId, matric } = {}) {
      if (isMemory()) {
        let list = mem().students;
        if (matric) list = list.filter(s => s.matric_number === matric);
        if (q) {
          const lc = q.toLowerCase();
          list = list.filter(s =>
            s.full_name.toLowerCase().includes(lc) ||
            s.matric_number.toLowerCase().includes(lc));
        }
        if (hostelId || roomId) {
          const allocs = mem().allocations.filter(a =>
            (!hostelId || a.hostel_id === hostelId) &&
            (!roomId || a.room_id === roomId));
          const ids = new Set(allocs.map(a => a.student_id));
          list = list.filter(s => ids.has(s.id));
        }
        return list;
      }
      const where = [];
      const params = [];
      if (matric) { where.push('s.matric_number = ?'); params.push(matric); }
      if (q) {
        where.push('(s.full_name LIKE ? OR s.matric_number LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      let sql = 'SELECT DISTINCT s.* FROM students s';
      if (hostelId || roomId) {
        sql += ' JOIN allocations a ON a.student_id = s.id';
        if (hostelId) { where.push('a.hostel_id = ?'); params.push(hostelId); }
        if (roomId)   { where.push('a.room_id = ?');    params.push(roomId); }
      }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY s.full_name LIMIT 500';
      return db.prepare(sql).all(...params);
    },
    create({ matric_number, full_name, gender, level, department }) {
      const now = dates.now();
      if (isMemory()) {
        const row = { id: mem().students.length + 1, matric_number, full_name, gender, level, department, created_at: now };
        mem().students.push(row);
        return row;
      }
      const info = db.prepare(`
        INSERT INTO students (matric_number, full_name, gender, level, department, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(matric_number, full_name, gender || null, level || null, department || null, now);
      return db.prepare('SELECT * FROM students WHERE id = ?').get(info.lastInsertRowid);
    },
  },

  allocations: {
    active() {
      if (isMemory()) return mem().allocations.filter(a => a.status === 'active');
      return db.prepare("SELECT * FROM allocations WHERE status = 'active'").all();
    },
    byStudent(studentId) {
      if (isMemory()) return mem().allocations.filter(a => a.student_id === studentId);
      return db.prepare('SELECT * FROM allocations WHERE student_id = ?').all(studentId);
    },
    byBed(bedSpaceId) {
      if (isMemory()) return mem().allocations.find(a => a.bed_space_id === bedSpaceId && a.status === 'active') || null;
      return db.prepare("SELECT * FROM allocations WHERE bed_space_id = ? AND status = 'active'").get(bedSpaceId) || null;
    },
    create(a) {
      const now = dates.now();
      if (isMemory()) {
        const row = { id: mem().allocations.length + 1, status: 'active', created_at: now, ...a };
        mem().allocations.push(row);
        return row;
      }
      const info = db.prepare(`
        INSERT INTO allocations
          (student_id, campus_id, hostel_id, room_id, bed_space_id, reference, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
      `).run(a.student_id, a.campus_id || null, a.hostel_id || null,
             a.room_id || null, a.bed_space_id || null, a.reference || null, now);
      return db.prepare('SELECT * FROM allocations WHERE id = ?').get(info.lastInsertRowid);
    },
  },

  scans: {
    create({ scope, campus_id, hostel_id }) {
      const now = dates.now();
      if (isMemory()) {
        const row = {
          id: mem().scans.length + 1, started_at: now, finished_at: null,
          status: 'queued', scope: scope || null,
          campus_id: campus_id || null, hostel_id: hostel_id || null,
          available_count: 0, occupied_count: 0, rooms_scanned: 0, error: null,
        };
        mem().scans.push(row);
        return row;
      }
      const info = db.prepare(`
        INSERT INTO scans (started_at, status, scope, campus_id, hostel_id)
        VALUES (?, 'queued', ?, ?, ?)
      `).run(now, scope || null, campus_id || null, hostel_id || null);
      return db.prepare('SELECT * FROM scans WHERE id = ?').get(info.lastInsertRowid);
    },
    update(id, patch) {
      if (isMemory()) {
        const row = mem().scans.find(s => s.id === id);
        if (row) Object.assign(row, patch);
        return row;
      }
      const fields = Object.keys(patch);
      if (!fields.length) return db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
      const sql = `UPDATE scans SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...fields.map(f => patch[f]), id);
      return db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
    },
    find(id) {
      if (isMemory()) return mem().scans.find(s => s.id === id) || null;
      return db.prepare('SELECT * FROM scans WHERE id = ?').get(id) || null;
    },
    latestSuccessful() {
      if (isMemory()) {
        return mem().scans.filter(s => s.status === 'success').sort((a, b) => b.id - a.id)[0] || null;
      }
      return db.prepare("SELECT * FROM scans WHERE status = 'success' ORDER BY id DESC LIMIT 1").get() || null;
    },
    list(limit = 50) {
      if (isMemory()) return mem().scans.slice().sort((a, b) => b.id - a.id).slice(0, limit);
      return db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?').all(limit);
    },
  },

  scanResults: {
    insertMany(scanId, rows) {
      if (isMemory()) {
        for (const r of rows) {
          mem().scan_results.push({ id: mem().scan_results.length + 1, scan_id: scanId, ...r });
        }
        return rows.length;
      }
      const stmt = db.prepare(`
        INSERT INTO scan_results
          (scan_id, campus_id, hostel_id, room_id, bed_space_id, status, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction(items => {
        for (const r of items) {
          stmt.run(scanId, r.campus_id || null, r.hostel_id || null,
                   r.room_id || null, r.bed_space_id || null,
                   r.status || 'unknown',
                   r.raw ? JSON.stringify(r.raw) : null);
        }
      });
      tx(rows);
      return rows.length;
    },
    byScan(scanId) {
      if (isMemory()) return mem().scan_results.filter(r => r.scan_id === scanId);
      return db.prepare('SELECT * FROM scan_results WHERE scan_id = ?').all(scanId);
    },
  },

  protectedSpaces: {
    all(filter = {}) {
      if (isMemory()) {
        return mem().protected_spaces.filter(p =>
          (!filter.status || p.status === filter.status) &&
          (!filter.hostelId || p.hostel_id === filter.hostelId) &&
          (!filter.activeOnly || !p.released_at));
      }
      const where = [];
      const params = [];
      if (filter.status)     { where.push('status = ?');     params.push(filter.status); }
      if (filter.hostelId)   { where.push('hostel_id = ?');  params.push(filter.hostelId); }
      if (filter.activeOnly) { where.push('released_at IS NULL'); }
      let sql = 'SELECT * FROM protected_spaces';
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY id DESC';
      return db.prepare(sql).all(...params);
    },
    byBed(bedSpaceId) {
      if (isMemory()) return mem().protected_spaces.find(p => p.bed_space_id === bedSpaceId && !p.released_at) || null;
      return db.prepare('SELECT * FROM protected_spaces WHERE bed_space_id = ? AND released_at IS NULL').get(bedSpaceId) || null;
    },
    create(p) {
      const now = dates.now();
      if (isMemory()) {
        const row = { id: mem().protected_spaces.length + 1, created_at: now, released_at: null, ...p };
        mem().protected_spaces.push(row);
        return row;
      }
      const info = db.prepare(`
        INSERT INTO protected_spaces
          (bed_space_id, room_id, hostel_id, campus_id, status, holder_name, holder_ref, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.bed_space_id, p.room_id || null, p.hostel_id || null,
             p.campus_id || null, p.status, p.holder_name || null,
             p.holder_ref || null, p.notes || null, now);
      return db.prepare('SELECT * FROM protected_spaces WHERE id = ?').get(info.lastInsertRowid);
    },
    release(id) {
      const now = dates.now();
      if (isMemory()) {
        const row = mem().protected_spaces.find(p => p.id === id);
        if (row) row.released_at = now;
        return row;
      }
      db.prepare('UPDATE protected_spaces SET released_at = ? WHERE id = ?').run(now, id);
      return db.prepare('SELECT * FROM protected_spaces WHERE id = ?').get(id);
    },
    update(id, patch) {
      if (isMemory()) {
        const row = mem().protected_spaces.find(p => p.id === id);
        if (row) Object.assign(row, patch);
        return row;
      }
      const fields = Object.keys(patch);
      if (!fields.length) return db.prepare('SELECT * FROM protected_spaces WHERE id = ?').get(id);
      const sql = `UPDATE protected_spaces SET ${fields.map(f => `${f} = ?`).join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...fields.map(f => patch[f]), id);
      return db.prepare('SELECT * FROM protected_spaces WHERE id = ?').get(id);
    },
    activeCount() {
      if (isMemory()) return mem().protected_spaces.filter(p => !p.released_at).length;
      return db.prepare('SELECT COUNT(*) c FROM protected_spaces WHERE released_at IS NULL').get().c;
    },
  },

  settings: {
    all() {
      if (isMemory()) return { ...mem().settings };
      const rows = db.prepare('SELECT key, value FROM settings').all();
      return Object.fromEntries(rows.map(r => [r.key, r.value]));
    },
    get(key) {
      if (isMemory()) return mem().settings[key];
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : undefined;
    },
    set(key, value) {
      if (isMemory()) { mem().settings[key] = String(value); return; }
      db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, String(value));
    },
  },
};

// ===========================================================================
// 6. security/credential-store.js — AES-256-GCM at rest
// ===========================================================================
const credentialStore = (() => {
  const KEY_FILE = path.join(DATA_DIR, '.cred-key');
  function getKey() {
    if (process.env.CREDENTIAL_KEY) {
      return crypto.createHash('sha256').update(process.env.CREDENTIAL_KEY).digest();
    }
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
    setPortalCredentials(username, password) {
      repos.settings.set('portal.username', username || '');
      repos.settings.set('portal.password.enc', password ? encrypt(password) : '');
    },
    getPortalUsername() {
      // Prefer stored value; fall back to env (useful for first boot)
      return repos.settings.get('portal.username') || process.env.PORTAL_USER || '';
    },
    hasPortalCredentials() {
      const u = repos.settings.get('portal.username') || process.env.PORTAL_USER;
      const p = repos.settings.get('portal.password.enc') || process.env.PORTAL_PASS;
      return !!(u && p);
    },
    // Only used by the scanner; never exposed via API.
    _getPortalPassword() {
      const stored = repos.settings.get('portal.password.enc');
      if (stored) return decrypt(stored);
      return process.env.PORTAL_PASS || '';
    },
  };
})();

// ===========================================================================
// 7. scanner/ — Real portal automation (mirrors hostelChecker.js)
// ===========================================================================

// --- scanner/result-parser.js --------------------------------------------
const resultParser = {
  /**
   * Converts raw observations from hostel-scanner into normalised rows.
   * Each observation: { campus_id, hostel_id, room_id, bed_space_id,
   *                     available: bool, raw }
   */
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
  normaliseRoomId(id) {
    return id ? String(id).trim().toUpperCase().replace(/\s+/g, '') : null;
  },
};

// --- scanner/portal-client.js --------------------------------------------
/**
 * Owns the Puppeteer browser and login step.
 * Mirrors the login() function from hostelChecker.js.
 * Credentials come ONLY from credentialStore.
 */
const portalClient = (() => {
  let browser = null;
  let loginPage = null;

  async function launch() {
    if (!puppeteer) throw new Error('puppeteer not installed — portal automation unavailable');
    if (browser) return browser;
    const headless = repos.settings.get('scanner.headless') === 'true';
    browser = await puppeteer.launch({
      headless,
      args: ['--disable-gpu', '--disable-extensions', '--no-sandbox', '--disable-setuid-sandbox'],
    });
    logger.info('Portal browser launched', { headless });
    return browser;
  }

  async function close() {
    if (browser) { await browser.close(); browser = null; loginPage = null; }
  }

  /**
   * Logs into the BIU portal and returns the authenticated page.
   * Selectors match hostelChecker.js (#Username, #Password, submit button).
   */
  async function login() {
    const username = credentialStore.getPortalUsername();
    const password = credentialStore._getPortalPassword();
    if (!username || !password) {
      throw new Error('Portal credentials not configured. Set PORTAL_USER / PORTAL_PASS or use /api/settings/portal-credentials.');
    }

    const baseURL = repos.settings.get('portal.baseURL') || process.env.BIU_PORTAL_URL || 'https://portal.biu.edu.ng';
    const loginPath = repos.settings.get('portal.loginPath') || '/Students/Login';
    const waitTimeout = parseInt(repos.settings.get('scanner.timeoutMs') || '60000', 10);

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

  function getLoginPage() { return loginPage; }
  return { launch, close, login, getLoginPage, isAvailable: () => !!puppeteer };
})();

// --- scanner/hostel-scanner.js -------------------------------------------
/**
 * The actual portal traversal.
 * This is a faithful port of scanHostel() from hostelChecker.js — same
 * selectors (#HostelId, #FloorId, #RoomId, #BedSpaceId), same stale-data
 * guards, same retry behaviour, same "only enabled = available" rule.
 *
 * Difference: instead of printing/logging to a text file, it returns
 * structured observations that feed result-parser → DB.
 */
const hostelScanner = (() => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const randomMs = ([min, max]) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

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

  /**
   * Guards against stale room lists — identical logic to hostelChecker.js.
   */
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

  /**
   * Reads the bed-space dropdown for the currently selected hostel/floor/room.
   * Only ENABLED beds count as available (matches hostelChecker.js).
   * Returns array of observation objects ready for the parser.
   */
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

  /**
   * Scans ONE hostel on the portal.
   * Returns observations for every (floor, room, bed) it managed to read.
   */
  async function scanHostel(page, { campusId, hostelName, hostelId, onProgress }) {
    const baseURL = repos.settings.get('portal.baseURL') || process.env.BIU_PORTAL_URL || 'https://portal.biu.edu.ng';
    const hostelPath = repos.settings.get('portal.hostelPath') || '/Students/Hostels';
    const delayCfg = [
      parseInt(repos.settings.get('scanner.randomDelayMin') || '700', 10),
      parseInt(repos.settings.get('scanner.randomDelayMax') || '1600', 10),
    ];

    logger.info(`Scanning hostel: ${hostelName}`);
    const observations = [];

    // Reload the hostel page fresh for each hostel (matches original script)
    await safeRun(async () => {
      await page.goto(baseURL + hostelPath, { waitUntil: 'networkidle2' });
      await sleep(1000);
    });

    // Clear downstream dropdowns so we never read stale options
    await clearDropdown(page, '#FloorId');
    await clearDropdown(page, '#RoomId');
    await clearDropdown(page, '#BedSpaceId');

    // -------- Select hostel --------
    const hostelOk = await selectDropdownOption(page, '#HostelId', hostelName);
    if (!hostelOk) {
      logger.warn(`Could not select hostel on portal`, { hostelName });
      return observations;
    }
    logger.info(`Selected hostel: ${hostelName}`);
    await sleep(1000);

    // -------- Wait for floors --------
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

    // -------- Iterate floors/flats --------
    for (const unitName of floors) {
      logger.info(`  Unit ${unitName}`);
      onProgress && onProgress({ hostelName, unitName });

      // Clear Room + BedSpace BEFORE changing floor (critical stale-data guard)
      const beforeRoomSig = await getOptionsSignature(page, '#RoomId');
      await clearDropdown(page, '#RoomId');
      await clearDropdown(page, '#BedSpaceId');
      await sleep(300);

      const floorOk = await selectDropdownOption(page, '#FloorId', unitName);
      if (!floorOk) { logger.warn(`Could not select unit ${unitName}`); continue; }

      // Wait for #RoomId to actually change
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
        logger.warn(`Suspicious room list for ${hostelName}/${unitName} — possible stale data; skipping`);
        continue;
      }

      logger.info(`    ${rooms.length} room(s) on ${unitName}`);

      // -------- Iterate rooms --------
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

// --- scanner/scan-queue.js ------------------------------------------------
const scanQueue = (() => {
  const queue = [];
  const running = new Set();
  const cancelled = new Set();

  function enqueue(job) {
    queue.push(job);
    logger.info('Scan job queued', { scanId: job.scanId });
    process.nextTick(drain);
  }

  function cancel(scanId) {
    if (running.has(scanId)) {
      cancelled.add(scanId);
      logger.warn('Scan cancellation requested', { scanId });
      return true;
    }
    const idx = queue.findIndex(j => j.scanId === scanId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      repos.scans.update(scanId, { status: 'cancelled', finished_at: dates.now() });
      logger.info('Queued scan cancelled before start', { scanId });
      return true;
    }
    return false;
  }

  async function drain() {
    const maxConcurrent = parseInt(repos.settings.get('scanner.maxConcurrent') || '1', 10);
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
// 8. services/
// ===========================================================================

// --- services/scanner.service.js -----------------------------------------
const scannerService = {
  async startScan({ scope, campusId, hostelId }) {
    const scan = repos.scans.create({
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
    repos.scans.update(scanId, { status: 'running' });
    logger.info('Scan started', { scanId, scope, campusId, hostelId });

    let page = null;
    let allObservations = [];
    let roomsScanned = 0;

    try {
      // -------- Determine targets from the real hostelConfig --------
      const flat = flattenHostelConfig();
      let targets = flat;
      if (scope === 'campus' && campusId) {
        targets = targets.filter(h => h.campusId === String(campusId).toLowerCase());
      } else if (scope === 'hostel' && hostelId) {
        targets = targets.filter(h =>
          h.hostelId === hostelId || String(h.portalId) === String(hostelId));
      }
      if (!targets.length) throw new Error('No matching hostels for scan scope');

      // -------- Login once, reuse page --------
      page = await portalClient.login();

      for (const t of targets) {
        if (scanQueue.isCancelled(scanId)) {
          repos.scans.update(scanId, { status: 'cancelled', finished_at: dates.now() });
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

        // Count unique rooms actually observed
        const uniqueRooms = new Set(obs.map(o => o.room_id));
        roomsScanned += uniqueRooms.size;

        allObservations = allObservations.concat(obs);

        // Small randomised delay between hostels (matches original script)
        const wait = 700 + Math.floor(Math.random() * 900);
        await new Promise(r => setTimeout(r, wait));
      }

      const parsed = resultParser.parse(allObservations);
      repos.scanResults.insertMany(scanId, parsed);

      const available = parsed.filter(p => p.status === 'available').length;
      const occupied  = parsed.filter(p => p.status === 'occupied').length;

      repos.scans.update(scanId, {
        status: 'success',
        finished_at: dates.now(),
        available_count: available,
        occupied_count: occupied,
        rooms_scanned: roomsScanned,
      });
      logger.info('Scan completed', { scanId, available, occupied, roomsScanned });
    } catch (err) {
      // CRITICAL: never overwrite the last successful snapshot on failure.
      // We only update the scans row for THIS run.
      repos.scans.update(scanId, {
        status: 'failed',
        finished_at: dates.now(),
        error: err.message,
      });
      logger.error('Scan failed', { scanId, err: err.message });
    } finally {
      if (page) await page.close().catch(() => {});
      // Keep browser reusable; uncomment to close after each scan:
      // await portalClient.close();
    }
  },

  progress(scanId) {
    const scan = repos.scans.find(scanId);
    if (!scan) return null;
    return { scan, queue: scanQueue.status() };
  },

  cancel(scanId) { return scanQueue.cancel(scanId); },
};

// --- services/inventory.service.js ---------------------------------------
const inventoryService = {
  /**
   * Combines four sources into the current inventory view:
   *   - configured structure   (what should exist)
   *   - latest successful scan (what the portal reported)
   *   - active allocations     (what we recorded)
   *   - active protected spaces(what we are holding)
   *
   * Resolution order per bed: protected > allocated > scan snapshot > unknown
   */
  buildView({ campusId, hostelId } = {}) {
    const latest = repos.scans.latestSuccessful();
    const snapshot = latest ? repos.scanResults.byScan(latest.id) : [];
    const snapshotByBed = new Map(snapshot.map(s => [s.bed_space_id, s]));

    const allocations = repos.allocations.active();
    const allocByBed = new Map(allocations.map(a => [a.bed_space_id, a]));

    const protectedList = repos.protectedSpaces.all({ activeOnly: true });
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
            // scan bed id uses `${roomKey}::${bedLabel}` format from hostel-scanner
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

// --- services/allocation.service.js --------------------------------------
const allocationService = {
  allocate({ studentId, campusId, hostelId, roomId, bedSpaceId, reference }) {
    if (!studentId || !bedSpaceId) throw new Error('studentId and bedSpaceId are required');
    const existing = repos.allocations.byBed(bedSpaceId);
    if (existing) throw new Error(`Bed ${bedSpaceId} already allocated`);
    const prot = repos.protectedSpaces.byBed(bedSpaceId);
    if (prot) throw new Error(`Bed ${bedSpaceId} is protected (${prot.status})`);

    return repos.allocations.create({
      student_id: studentId, campus_id: campusId, hostel_id: hostelId,
      room_id: roomId, bed_space_id: bedSpaceId, reference: reference || null,
    });
  },
  lookupByStudent(studentId) { return repos.allocations.byStudent(studentId); },
};

// --- services/protected-spaces.service.js --------------------------------
const protectedSpacesService = {
  create({ bedSpaceId, roomId, hostelId, campusId, status, holderName, holderRef, notes }) {
    if (!bedSpaceId) throw new Error('bedSpaceId is required');
    const allowed = ['reserved', 'held', 'payment_pending'];
    if (!allowed.includes(status)) throw new Error(`status must be one of ${allowed.join(', ')}`);
    if (repos.protectedSpaces.byBed(bedSpaceId)) throw new Error(`Bed ${bedSpaceId} is already protected`);
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

// --- services/scan-history.service.js ------------------------------------
const scanHistoryService = {
  list(limit = 50) { return repos.scans.list(limit); },
  detail(scanId) {
    const scan = repos.scans.find(scanId);
    if (!scan) return null;
    return { scan, results: repos.scanResults.byScan(scanId) };
  },
  lastSuccessful() { return repos.scans.latestSuccessful(); },
};

// --- services/report.service.js ------------------------------------------
const reportService = {
  summary() {
    const scans = repos.scans.list(1000);
    const success = scans.filter(s => s.status === 'success').length;
    const failed  = scans.filter(s => s.status === 'failed').length;
    return {
      totalScans: scans.length,
      successfulScans: success,
      failedScans: failed,
      lastSuccessfulScan: repos.scans.latestSuccessful(),
      protectedActive: repos.protectedSpaces.activeCount(),
      generatedAt: dates.now(),
    };
  },
  trend(days = 14) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const scans = repos.scans.list(1000).filter(s => s.started_at >= cutoff);
    const byDay = {};
    for (const s of scans) {
      const day = s.started_at.slice(0, 10);
      if (!byDay[day]) byDay[day] = { day, available: 0, occupied: 0, scans: 0 };
      byDay[day].available += s.available_count || 0;
      byDay[day].occupied  += s.occupied_count  || 0;
      byDay[day].scans     += 1;
    }
    return Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  },
  hostelComparison() {
    const view = inventoryService.buildView();
    return view.hostels.map(h => ({
      hostelId: h.hostelId, hostelName: h.hostelName,
      campusName: h.campusName, gender: h.gender,
      ...h.totals,
    }));
  },
};

// --- services/export.service.js ------------------------------------------
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

// --- services/settings.service.js ----------------------------------------
const settingsService = {
  getAll(redactSecrets = true) {
    const all = repos.settings.all();
    if (!redactSecrets) return all;
    const safe = { ...all };
    delete safe['portal.password.enc'];
    safe['portal.passwordSet'] = !!all['portal.password.enc'];
    safe['portal.username'] = all['portal.username'] || process.env.PORTAL_USER || '';
    return safe;
  },
  update(patch) {
    const allowed = [
      'app.name',
      'scanner.headless', 'scanner.timeoutMs', 'scanner.maxConcurrent',
      'scanner.retryCount', 'scanner.randomDelayMin', 'scanner.randomDelayMax',
      'portal.baseURL', 'portal.loginPath', 'portal.hostelPath',
      'backup.retentionDays', 'backup.autoEnabled',
    ];
    for (const [k, v] of Object.entries(patch || {})) {
      if (allowed.includes(k)) repos.settings.set(k, v);
    }
    return this.getAll();
  },
  updatePortalCredentials(username, password) {
    credentialStore.setPortalCredentials(username, password);
    return { username, passwordSet: !!password };
  },
  testPortalConnection() {
    return {
      configured: credentialStore.hasPortalCredentials(),
      username: credentialStore.getPortalUsername() || null,
      baseURL: repos.settings.get('portal.baseURL') || process.env.BIU_PORTAL_URL,
      puppeteerAvailable: portalClient.isAvailable(),
    };
  },
};

// --- services/backup.service.js ------------------------------------------
const backupService = {
  createBackup() {
    if (isMemory()) throw new Error('Backup requires persistent SQLite database');
    const filename = `backup-${Date.now()}.db`;
    const full = path.join(BACKUP_DIR, filename);
    db.prepare('VACUUM INTO ?').run(full);
    logger.info('Backup created', { file: filename });
    return { filename, path: full, sizeBytes: fs.statSync(full).size };
  },
  listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { filename: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    });
  },
};

// ===========================================================================// 9. middleware/
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
  const message = status >= 500 && NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Internal server error';
  res.status(status).json({ error: message });
}

const asyncWrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ===========================================================================
// 10. Express app + routes
// ===========================================================================
function createApp() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({
    name: 'hsf.sid',
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, sameSite: 'lax',
      secure: NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8,
    },
  }));

  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Health ----
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true, env: NODE_ENV, time: dates.now(),
      db: isMemory() ? 'memory' : 'sqlite',
      puppeteer: portalClient.isAvailable(),
    });
  });

  // ---- Auth ----
  app.post('/api/auth/login',
    validate.body({ username: { required: true, type: 'string' }, password: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) => {
      const { username, password } = req.body;
      const user = repos.users.findByUsername(username);
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

  app.get('/api/auth/me', requireAuth, (req, res) => {
    res.json({ user: repos.users.findById(req.session.userId) });
  });

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
  api.get('/dashboard', (req, res) => {
    const latest = repos.scans.latestSuccessful();
    const view = inventoryService.buildView();
    const totals = view.hostels.reduce((acc, h) => {
      for (const k of Object.keys(h.totals)) acc[k] = (acc[k] || 0) + h.totals[k];
      return acc;
    }, { available: 0, occupied: 0, held: 0, unknown: 0, allocated: 0 });

    res.json({
      appName: repos.settings.get('app.name') || 'Hostel Space Finder',
      lastSuccessfulScan: latest,
      totals,
      hostelSummaries: view.hostels.map(h => ({
        hostelId: h.hostelId, hostelName: h.hostelName,
        campusName: h.campusName, gender: h.gender,
        totals: h.totals,
      })),
      recentScans: repos.scans.list(10),
      protectedActive: repos.protectedSpaces.activeCount(),
      generatedAt: dates.now(),
    });
  });

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
  api.get('/scanner/progress/:scanId', (req, res) => {
    const p = scannerService.progress(parseInt(req.params.scanId, 10));
    if (!p) return res.status(404).json({ error: 'Scan not found' });
    res.json(p);
  });
  api.get('/scanner/result/:scanId', (req, res) => {
    const d = scanHistoryService.detail(parseInt(req.params.scanId, 10));
    if (!d) return res.status(404).json({ error: 'Scan not found' });
    res.json(d);
  });
  api.post('/scanner/cancel/:scanId', (req, res) => {
    res.json({ cancelled: scannerService.cancel(parseInt(req.params.scanId, 10)) });
  });
  api.get('/scanner/queue', (req, res) => res.json(scanQueue.status()));
  api.get('/scanner/errors', (req, res) => {
    const failed = repos.scans.list(50).filter(s => s.status === 'failed');
    res.json({ failed });
  });

  // ---- Inventory ----
  api.get('/inventory', (req, res) => {
    res.json(inventoryService.buildView({
      campusId: req.query.campusId, hostelId: req.query.hostelId,
    }));
  });
  api.get('/inventory/campuses', (req, res) => res.json({ campuses: repos.campuses.all() }));
  api.get('/inventory/hostels', (req, res) => {
    if (req.query.campusId) return res.json({ hostels: repos.hostels.byCampus(req.query.campusId) });
    res.json({ hostels: repos.hostels.all() });
  });
  api.get('/inventory/rooms/:hostelId', (req, res) =>
    res.json({ rooms: repos.rooms.byHostel(req.params.hostelId) }));
  api.get('/inventory/beds/:roomId', (req, res) =>
    res.json({ beds: repos.beds.byRoom(req.params.roomId) }));

  // ---- Students ----
  api.get('/students', (req, res) => {
    const students = repos.students.search({
      q: req.query.q, hostelId: req.query.hostelId,
      roomId: req.query.roomId, matric: req.query.matric,
    });
    res.json({
      students: students.map(s => ({ ...s, allocations: repos.allocations.byStudent(s.id) })),
    });
  });
  api.post('/students',
    validate.body({ matric_number: { required: true, type: 'string' }, full_name: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) => res.status(201).json({ student: repos.students.create(req.body) }))
  );
  api.post('/students/allocate',
    validate.body({ studentId: { required: true, type: 'number' }, bedSpaceId: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) => res.status(201).json({ allocation: allocationService.allocate(req.body) }))
  );
  api.get('/students/:studentId/allocations', (req, res) =>
    res.json({ allocations: allocationService.lookupByStudent(parseInt(req.params.studentId, 10)) }));

  // ---- Protected spaces ----
  api.get('/protected-spaces', (req, res) => {
    res.json({
      protectedSpaces: protectedSpacesService.list({
        status: req.query.status, hostelId: req.query.hostelId,
        activeOnly: req.query.activeOnly !== 'false',
      }),
    });
  });
  api.post('/protected-spaces',
    validate.body({
      bedSpaceId: { required: true, type: 'string' },
      status: { required: true, type: 'string', enum: ['reserved', 'held', 'payment_pending'] },
    }),
    asyncWrap(async (req, res) => res.status(201).json({ protectedSpace: protectedSpacesService.create(req.body) }))
  );
  api.patch('/protected-spaces/:id', asyncWrap(async (req, res) => {
    const rec = protectedSpacesService.update(parseInt(req.params.id, 10), req.body || {});
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ protectedSpace: rec });
  }));
  api.post('/protected-spaces/:id/release', asyncWrap(async (req, res) => {
    const rec = protectedSpacesService.release(parseInt(req.params.id, 10));
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json({ protectedSpace: rec });
  }));

  // ---- History ----
  api.get('/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    res.json({ scans: scanHistoryService.list(limit) });
  });
  api.get('/history/:scanId', (req, res) => {
    const d = scanHistoryService.detail(parseInt(req.params.scanId, 10));
    if (!d) return res.status(404).json({ error: 'Scan not found' });
    res.json(d);
  });

  // ---- Reports ----
  api.get('/reports/summary', (req, res) => res.json(reportService.summary()));
  api.get('/reports/trend', (req, res) => {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 180);
    res.json({ days, trend: reportService.trend(days) });
  });
  api.get('/reports/hostels', (req, res) => res.json({ hostels: reportService.hostelComparison() }));
  api.get('/reports/export', asyncWrap(async (req, res) => {
    const type = req.query.type || 'inventory';
    let rows;
    if (type === 'inventory') rows = reportService.hostelComparison();
    else if (type === 'history') rows = scanHistoryService.list(1000);
    else if (type === 'protected') rows = protectedSpacesService.list({ activeOnly: false });
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
  api.get('/settings', (req, res) => res.json({ settings: settingsService.getAll() }));
  api.patch('/settings', asyncWrap(async (req, res) =>
    res.json({ settings: settingsService.update(req.body || {}) })));
  api.post('/settings/portal-credentials',
    validate.body({ username: { required: true, type: 'string' }, password: { required: true, type: 'string' } }),
    asyncWrap(async (req, res) =>
      res.json(settingsService.updatePortalCredentials(req.body.username, req.body.password))));
  api.post('/settings/portal-test', (req, res) => res.json(settingsService.testPortalConnection()));
  api.post('/settings/backup', asyncWrap(async (req, res) => res.json(backupService.createBackup())));
  api.get('/settings/backups', (req, res) => res.json({ backups: backupService.listBackups() }));

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
// 11. Bootstrap + graceful shutdown
// ===========================================================================
async function start() {
  ensureDirs();
  initDatabase();

  const app = createApp();
  const server = app.listen(PORT, () => {
    logger.info('Hostel Space Finder server listening', {
      port: PORT, env: NODE_ENV, url: `http://localhost:${PORT}`,
    });
  });

  const shutdown = async (signal) => {
    logger.warn(`Received ${signal}, shutting down...`);
    server.close(async () => {
      try {
        await portalClient.close();
        if (db && !isMemory()) db.close();
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

if (require.main === module) start();

module.exports = { createApp, start, hostelConfig, flattenHostelConfig };