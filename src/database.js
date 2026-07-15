
// src/database.js
// SW.CA1 — Database module
// Uses sql.js (browser-compatible SQLite — no build tools needed)
// Updated M11.5 — adds conversations table, direction + conversation_id on messages
// Updated M11.6 — adds deadline_rules table, current_period/period_start/period_end
//                 on client_services, deadline_override_flag on clients
// Updated M11.7 — adds document_checklist_status table
// Updated M11.8 — adds frequency/due_day/due_month_offset on subtasks,
//                 subtask_id on service_document_map, is_qrmp on clients

const path = require('path');
const fs   = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'swca1.db');

let db = null; // single shared instance

// ── Boot ──────────────────────────────────────────────────────────────────────
async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing file or start fresh
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  createTables();
  saveDatabase();
  console.log('[DB] Database ready at', DB_PATH);
  return db;
}

// ── Persist to disk ───────────────────────────────────────────────────────────
function saveDatabase() {
  if (!db) return;
  const dataDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Accessor for other modules ────────────────────────────────────────────────
function getDb() {
  return db;
}

// ── Schema ────────────────────────────────────────────────────────────────────
function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS clients (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT,
      phone         TEXT,
      gst_number    TEXT,
      pan_number    TEXT,
      notes         TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source          TEXT NOT NULL,          -- 'gmail' | 'whatsapp'
      account         TEXT,                   -- which gmail address / whatsapp number
      sender_name     TEXT,
      sender_email    TEXT,
      sender_phone    TEXT,
      subject         TEXT,
      body            TEXT,
      category        TEXT,                   -- Invoice / Request / Inquiry / etc.
      urgency         TEXT,                   -- High / Medium / Low
      ai_summary      TEXT,
      attachment_count INTEGER DEFAULT 0,
      raw_id          TEXT,                   -- Gmail message ID / WhatsApp serialized ID
      received_at     DATETIME,
      processed       INTEGER DEFAULT 0,      -- 0 = pending AI, 1 = done
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id  INTEGER REFERENCES messages(id),
      filename    TEXT,
      mime_type   TEXT,
      size_bytes  INTEGER,
      gmail_part_id TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS services (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      is_default  INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO services (name, is_default) VALUES
      ('GST', 1), ('ITR', 1), ('TDS', 1)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS client_services (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id  INTEGER REFERENCES clients(id),
      service_id INTEGER REFERENCES services(id),
      status     TEXT DEFAULT 'Pending',
      UNIQUE(client_id, service_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS subtasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id  INTEGER REFERENCES services(id),
      name        TEXT NOT NULL,
      sort_order  INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS client_subtask_status (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id),
      subtask_id  INTEGER REFERENCES subtasks(id),
      status      TEXT DEFAULT 'Pending',
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, subtask_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS custom_columns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      column_type  TEXT NOT NULL,   -- 'dropdown' | 'date' | 'checkbox' | 'text' | 'number'
      options      TEXT,            -- JSON array for dropdown type
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS custom_column_values (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id        INTEGER REFERENCES clients(id),
      custom_column_id INTEGER REFERENCES custom_columns(id),
      value            TEXT,
      UNIQUE(client_id, custom_column_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS client_sources (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id  INTEGER REFERENCES clients(id),
      type       TEXT NOT NULL,    -- 'email' | 'whatsapp'
      value      TEXT NOT NULL,    -- actual address / number
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, type, value)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS timeline (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id),
      type        TEXT,            -- 'message' | 'status_change' | 'payment' | 'note'
      message_id  INTEGER REFERENCES messages(id),
      content     TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id),
      service_id  INTEGER REFERENCES services(id),
      amount      REAL,
      method      TEXT,
      notes       TEXT,
      paid_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // service_name_snapshot — a plain-text copy of the service's name at the
  // time of payment. payments.service_id is looked up LIVE against the
  // services table for display, which means deleting a service would blank
  // out every past payment's service label even though the amount/date/notes
  // are untouched. The snapshot survives regardless: reads should prefer
  // COALESCE(services.name, payments.service_name_snapshot). Deleting a
  // service also nulls out service_id on its payments and relies on this
  // column from then on.
  try { db.run(`ALTER TABLE payments ADD COLUMN service_name_snapshot TEXT`); } catch (e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT,
      client_id   INTEGER REFERENCES clients(id),
      message     TEXT,
      resolved    INTEGER DEFAULT 0,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default settings
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_model', 'gemma3:4b')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'ocean')`);

  // New table: service → document mappings (M8 Feature E)
  db.run(`
    CREATE TABLE IF NOT EXISTS service_document_map (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER REFERENCES services(id),
      doc_type   TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(service_id, doc_type)
    )
  `);

  // ── M11.5 — Conversations table ───────────────────────────────────────────
  // One record per active conversation thread between a client and the CA.
  // Groups multiple related messages into a single card in Layer 1 (Unified Inbox).
  //
  // How a thread is matched:
  //   Same client_id + same service_tag + status is 'open'
  //   + last message arrived within the thread_window_days setting (default 7 days)
  //
  // running_summary: updated by Pass 2 after each new message — always reflects
  //   the latest state of the full conversation, not just the last message.
  //
  // resolved_at: set when the thread closes (by timer, AI detection, or document receipt)
  // resolved_reason: 'auto_timer' | 'ai_detected' | 'document_received' | 'manual'
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id       INTEGER REFERENCES clients(id),
      service_tag     TEXT,                       -- service name this thread belongs to (or null)
      status          TEXT DEFAULT 'open',        -- 'open' | 'resolved'
      running_summary TEXT,                       -- evolving AI summary of the full thread
      message_count   INTEGER DEFAULT 0,          -- total messages in this thread
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at     DATETIME,
      resolved_reason TEXT                        -- 'auto_timer' | 'ai_detected' | 'document_received' | 'manual'
    )
  `);

  // ── M11.6 — Deadline Rules table ─────────────────────────────────────────
  // One row per service. Defines when that service's deadline recurs.
  //
  // rule_type:  'monthly' | 'quarterly' | 'annual'
  // due_day:    day of the month the filing is due (e.g. 20 for GSTR-1)
  // due_month:  month number (1–12) for annual rules only (e.g. 7 = July for ITR)
  //             NULL for monthly and quarterly rules — month is derived from period
  // alert_days: how many days before the deadline to fire a notification (default 3)
  //             Used by M12 Smart Alerts. Stored here so it's configurable per service.
  db.run(`
    CREATE TABLE IF NOT EXISTS deadline_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id  INTEGER REFERENCES services(id) UNIQUE,
      rule_type   TEXT NOT NULL DEFAULT 'monthly',
      due_day     INTEGER,
      due_month   INTEGER,
      alert_days  INTEGER DEFAULT 3,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default deadline rules for the three built-in services.
  // Uses a subquery to look up service ID by name — safe on all installs.
  // INSERT OR IGNORE — will not overwrite if the CA has already customised a rule.
  db.run(`INSERT OR IGNORE INTO deadline_rules (service_id, rule_type, due_day, due_month, alert_days)
    SELECT id, 'monthly', 20, NULL, 3 FROM services WHERE name = 'GST'`);

  db.run(`INSERT OR IGNORE INTO deadline_rules (service_id, rule_type, due_day, due_month, alert_days)
    SELECT id, 'annual', 31, 7, 7 FROM services WHERE name = 'ITR'`);

  db.run(`INSERT OR IGNORE INTO deadline_rules (service_id, rule_type, due_day, due_month, alert_days)
    SELECT id, 'quarterly', 31, NULL, 7 FROM services WHERE name = 'TDS'`);

  // ── M11.7 — Document Checklist Status table ───────────────────────────────
  // Tracks which documents have been received for each client × service × period.
  //
  // One row per (client, service, period, doc_type) — enforced by UNIQUE constraint.
  // The UNIQUE key means upserts work cleanly via ON CONFLICT DO UPDATE.
  //
  // status:            'pending' | 'received'
  // source_message_id: the message that triggered the AI auto-mark (nullable)
  // manually_set:      1 = CA manually set this status, 0 = AI auto-marked
  //                    When manually_set = 1, AI will not overwrite the status.
  db.run(`
    CREATE TABLE IF NOT EXISTS document_checklist_status (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id         INTEGER REFERENCES clients(id),
      service_id        INTEGER REFERENCES services(id),
      period            TEXT NOT NULL,
      doc_type          TEXT NOT NULL,
      status            TEXT DEFAULT 'pending',
      received_at       DATETIME,
      source_message_id INTEGER REFERENCES messages(id),
      manually_set      INTEGER DEFAULT 0,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, service_id, period, doc_type)
    )
  `);

  // ── Migrations — safe to run on existing DBs ──────────────────────────────
  // Each is wrapped in try/catch — if the column already exists, SQLite throws
  // and we silently continue. This means the file is safe to deploy on both
  // fresh installs and existing databases.

  // M7 / M8 migrations (already present — kept here for completeness)
  try { db.run(`ALTER TABLE clients ADD COLUMN ai_summary TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE clients ADD COLUMN next_deadline TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE clients ADD COLUMN filing_date TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE timeline ADD COLUMN entry_type TEXT DEFAULT 'message'`); } catch (e) {}
  try { db.run(`ALTER TABLE timeline ADD COLUMN entry_date TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE attachments ADD COLUMN gmail_message_id TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE attachments ADD COLUMN local_path TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE timeline ADD COLUMN service_name TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE messages ADD COLUMN service_name TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE subtasks ADD COLUMN source_message_id INTEGER`); } catch (e) {}
  try { db.run(`ALTER TABLE subtasks ADD COLUMN client_id INTEGER`); } catch (e) {}

  // M11.5 migrations — new columns on the existing messages table
  //
  // direction: was this message sent by the client (incoming) or the CA (outgoing)?
  //   'incoming' = client message — shown in inbox, processed by AI
  //   'outgoing' = CA reply     — hidden from inbox, used as AI context only
  //   NULL = pre-M11.5 messages (treated as incoming everywhere for backward compat)
  try { db.run(`ALTER TABLE messages ADD COLUMN direction TEXT DEFAULT 'incoming'`); } catch (e) {}

  // M11.6 migrations ────────────────────────────────────────────────────────
  // deadline_override_flag on clients:
  //   0 (default) = engine is free to auto-populate next_deadline from rules
  //   1           = CA has manually set next_deadline — engine will not overwrite
  //                 Reset to 0 when the CA clears the date or clicks "Reset to Auto"
  try { db.run(`ALTER TABLE clients ADD COLUMN deadline_override_flag INTEGER DEFAULT 0`); } catch (e) {}

  // current_period on client_services:
  //   The active filing period for this client+service combination.
  //   Monthly:   "YYYY-MM"     e.g. "2026-06"
  //   Quarterly: "YYYY-QN"    e.g. "2026-Q1"  (Q1 = Apr–Jun of that FY year)
  //   Annual:    "FY-YYYY-YY" e.g. "FY-2025-26"
  //   NULL until the deadline engine initialises it on first run.
  try { db.run(`ALTER TABLE client_services ADD COLUMN current_period TEXT`); } catch (e) {}

  // period_start and period_end: the calendar dates of the current_period.
  //   Set by the deadline engine alongside current_period.
  //   Used by M11.8 Compliance Overview to scope the grid to the right period.
  try { db.run(`ALTER TABLE client_services ADD COLUMN period_start DATE`); } catch (e) {}
  try { db.run(`ALTER TABLE client_services ADD COLUMN period_end DATE`); } catch (e) {}

  // rule_type_override on client_services — lets ONE client run a service on a
  // different filing cadence than the service's own default (e.g. a QRMP client
  // filing GST quarterly while every other GST client stays monthly).
  //   NULL (default)        — use the service's own deadline_rules.rule_type, unchanged.
  //   'monthly'/'quarterly'/'annual' — overrides the cadence for this client+service only.
  // Set from the Compliance Overview side panel alongside the period itself.
  // due_day/due_month are NOT overridden by this — those still come from the
  // service's own deadline_rules regardless of this override.
  try { db.run(`ALTER TABLE client_services ADD COLUMN rule_type_override TEXT`); } catch (e) {}

  // conversation_id: which conversation thread does this message belong to?
  //   NULL = unlinked sender (no client profile) OR message pre-dates M11.5
  //   Set by the AI processor after thread matching logic runs
  try { db.run(`ALTER TABLE messages ADD COLUMN conversation_id INTEGER REFERENCES conversations(id)`); } catch (e) {}

  // Seed M11.5 settings
  // thread_window_days: how many days of inactivity before a new message starts
  //   a fresh thread instead of folding into the existing one (default 7 days)
  // auto_resolve_days: how many days of inactivity before an open thread is
  //   automatically closed by the timer (Option 1 auto-resolution, default 5 days)
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('thread_window_days', '7')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_resolve_days', '5')`);

  // Seed other default settings
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('attachment_mode', 'gmail_link')`);

  // M11.8 migrations ────────────────────────────────────────────────────────

  // frequency on subtasks:
  //   Controls which filing period type this subtask applies to.
  //   NULL (default) = backward compatible — engine counts it for any period type.
  //   'monthly'      = only counted when advancing a monthly period.
  //   'quarterly'    = only counted when advancing a quarterly period.
  //   'annual'       = only counted when advancing an annual period.
  //   This is the fix for GSTR-9 blocking the monthly GST period advance.
  try { db.run(`ALTER TABLE subtasks ADD COLUMN frequency TEXT`); } catch (e) {}

  // due_day on subtasks:
  //   Day of the month this subtask is individually due.
  //   Separate from the service-level deadline in deadline_rules.
  //   NULL = not configured. Displayed in Compliance Overview side panel (M11.8).
  //   Will power per-subtask deadline alerts in M12.
  try { db.run(`ALTER TABLE subtasks ADD COLUMN due_day INTEGER`); } catch (e) {}

  // due_month_offset on subtasks:
  //   How many months after the period end this subtask's due_day falls.
  //   0 = same month as period end. 1 = one month after period end. NULL = not set.
  //   Example: GSTR-1 for June 2026 is due July 11 → due_month_offset=1, due_day=11.
  try { db.run(`ALTER TABLE subtasks ADD COLUMN due_month_offset INTEGER`); } catch (e) {}

  // subtask_id on service_document_map:
  //   Optional FK linking a standard document to the subtask that requires it.
  //   e.g. "GSTR-2B PDF" → "GSTR-2B Reconciliation" subtask.
  //   NULL = document is not linked to a specific subtask (standalone checklist item).
  //   Set from Settings → Service Configuration. Read by Compliance Overview (M11.8).
  try { db.run(`ALTER TABLE service_document_map ADD COLUMN subtask_id INTEGER REFERENCES subtasks(id)`); } catch (e) {}

  // alert_days on subtasks (M12):
  //   How many days before THIS subtask's own due date to flag it as
  //   "deadline_alert" / fire a Smart Alert notification. Mirrors
  //   deadline_rules.alert_days, but scoped to one subtask instead of the
  //   whole service — each subtask can have a different warning window
  //   (e.g. GSTR-1 alert 5 days out, GSTR-2B Reconciliation alert 2 days out).
  //   NULL = not configured — falls back to a default of 3 in application code.
  try { db.run(`ALTER TABLE subtasks ADD COLUMN alert_days INTEGER`); } catch (e) {}

  // is_qrmp on clients:
  //   1 = this client files under the QRMP (Quarterly Return Monthly Payment) scheme.
  //   0 = standard filer (default).
  //   Per-client — different clients can be on different schemes.
  //   Set from the client profile page. Displayed in Compliance Overview (M11.8).
  try { db.run(`ALTER TABLE clients ADD COLUMN is_qrmp INTEGER DEFAULT 0`); } catch (e) {}

  // Seed: mark GSTR-9 as annual so it does not block monthly GST period advance.
  // The deadline engine's subtask-completion check now filters by frequency,
  // so GSTR-9 (annual) is excluded when evaluating monthly GST periods.
  // Safe to re-run — UPDATE WHERE on a known static name is idempotent.
  try { db.run(`UPDATE subtasks SET frequency = 'annual' WHERE name = 'GSTR-9'`); } catch (e) {}

  // ── M12 migrations — Smart Alerts & Notification Bell ────────────────────

  // contact_alert_days on clients:
  //   How many days of silence (no incoming message) before "Client not
  //   contacted" fires for this client. NULL = not configured — falls back
  //   to the 'default_contact_alert_days' setting (seeded below) if unset.
  //   Editable from the client profile page.
  try { db.run(`ALTER TABLE clients ADD COLUMN contact_alert_days INTEGER`); } catch (e) {}

  // Global fallback used when a client has no contact_alert_days of their own.
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('default_contact_alert_days', '5')`);

  // notifications table — extended for Smart Alerts (M12).
  // Originally just {type, client_id, message, resolved} and unused since
  // creation. Extended with the fields needed to scope + dedupe alerts and
  // track their lifecycle:
  //
  //   service_id / subtask_id / period — together with client_id and type,
  //     these form the "instance key" the alert engine checks before firing,
  //     so the same condition never creates a duplicate notification for the
  //     same period. subtask_id and period are NULL for alert types that
  //     aren't subtask/period-scoped (e.g. 'client_not_contacted').
  //
  //   status — 'active' | 'dismissed' | 'resolved'
  //     active    — currently showing in the notification bell
  //     dismissed — CA closed it manually; stays hidden unless the underlying
  //                 condition clears and then re-triggers as a fresh instance
  //     resolved  — the sweep found the condition no longer true and
  //                 auto-cleared it; kept for history, not shown in the bell
  //   The old `resolved` INTEGER column is kept for backward compatibility
  //   but `status` is the source of truth going forward.
  //
  //   dismissed_at / resolved_at — timestamps for the two clearing paths.
  try { db.run(`ALTER TABLE notifications ADD COLUMN service_id INTEGER REFERENCES services(id)`); } catch (e) {}
  try { db.run(`ALTER TABLE notifications ADD COLUMN subtask_id INTEGER REFERENCES subtasks(id)`); } catch (e) {}
  try { db.run(`ALTER TABLE notifications ADD COLUMN period TEXT`); } catch (e) {}
  try { db.run(`ALTER TABLE notifications ADD COLUMN status TEXT DEFAULT 'active'`); } catch (e) {}
  try { db.run(`ALTER TABLE notifications ADD COLUMN dismissed_at DATETIME`); } catch (e) {}
  try { db.run(`ALTER TABLE notifications ADD COLUMN resolved_at DATETIME`); } catch (e) {}

  // updated_at on document_checklist_status:
  //   client_subtask_status already tracked updated_at; this table didn't.
  //   Needed for M12 conflict detection — comparing "was this row touched
  //   within the last few seconds by someone else" requires a last-modified
  //   timestamp, and created_at only reflects the row's first insert.
  try { db.run(`ALTER TABLE document_checklist_status ADD COLUMN updated_at DATETIME`); } catch (e) {}

  saveDatabase();
}

module.exports = { initDatabase, getDb, saveDatabase };
