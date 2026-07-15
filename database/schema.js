// SW.CA1 — Complete Database Schema
// All tables defined here. Run once on first startup.

const createTables = (db) => {

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      company     TEXT,
      phone       TEXT,
      email       TEXT,
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK(type IN ('gmail','whatsapp')),
      identifier  TEXT NOT NULL,
      label       TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type       TEXT NOT NULL CHECK(source_type IN ('gmail','whatsapp')),
      source_account    TEXT NOT NULL,
      sender_identifier TEXT NOT NULL,
      sender_name       TEXT,
      client_id         INTEGER REFERENCES clients(id) ON DELETE SET NULL,
      raw_subject       TEXT,
      raw_body          TEXT,
      category          TEXT,
      urgency           TEXT CHECK(urgency IN ('High','Medium','Low')),
      ai_summary        TEXT,
      received_at       TEXT NOT NULL,
      processed         INTEGER DEFAULT 0,
      created_at        TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      filename     TEXT NOT NULL,
      file_type    TEXT,
      file_size    INTEGER,
      reference_id TEXT,
      service_tag  TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      is_default   INTEGER DEFAULT 0,
      sort_order   INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS client_services (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id        INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      service_id       INTEGER REFERENCES services(id) ON DELETE CASCADE,
      status           TEXT DEFAULT 'Pending' CHECK(status IN ('Filed','Pending','Under Review','N/A')),
      next_deadline    TEXT,
      scheduled_date   TEXT,
      action_needed    TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, service_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS subtasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id  INTEGER REFERENCES services(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS client_subtasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      subtask_id  INTEGER REFERENCES subtasks(id) ON DELETE CASCADE,
      status      TEXT DEFAULT 'Pending' CHECK(status IN ('Pending','In Progress','Done')),
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, subtask_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      service_id  INTEGER REFERENCES services(id) ON DELETE SET NULL,
      amount      REAL NOT NULL,
      received_on TEXT,
      method      TEXT CHECK(method IN ('Cash','UPI','Bank Transfer','Other')),
      notes       TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS timeline_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      detail      TEXT,
      service_id  INTEGER REFERENCES services(id) ON DELETE SET NULL,
      message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_columns (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL,
      column_type  TEXT NOT NULL CHECK(column_type IN ('text','number','date','checkbox','dropdown')),
      options      TEXT,
      sort_order   INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_column_values (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id        INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      custom_column_id INTEGER REFERENCES custom_columns(id) ON DELETE CASCADE,
      value            TEXT,
      updated_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(client_id, custom_column_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL,
      title       TEXT NOT NULL,
      detail      TEXT,
      client_id   INTEGER REFERENCES clients(id) ON DELETE CASCADE,
      resolved    INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL,
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT,
      sync_type    TEXT,
      status       TEXT,
      conflict     INTEGER DEFAULT 0,
      detail       TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  console.log('[DB] All tables created or verified.');
};

const seedDefaults = (db) => {
  const existing = db.prepare('SELECT COUNT(*) as count FROM services').get();
  if (existing.count > 0) return;

  const insertService = db.prepare(
    'INSERT INTO services (name, is_default, sort_order) VALUES (?, 1, ?)'
  );
  const gst = insertService.run('GST', 1);
  const itr = insertService.run('ITR', 2);
  const tds = insertService.run('TDS', 3);

  const insertSubtask = db.prepare(
    'INSERT INTO subtasks (service_id, name, sort_order) VALUES (?, ?, ?)'
  );

  insertSubtask.run(gst.lastInsertRowid, 'GSTR-1', 1);
  insertSubtask.run(gst.lastInsertRowid, 'GSTR-2B', 2);
  insertSubtask.run(gst.lastInsertRowid, 'GSTR-3B', 3);
  insertSubtask.run(gst.lastInsertRowid, 'GSTR-9', 4);

  insertSubtask.run(itr.lastInsertRowid, 'Document Collection', 1);
  insertSubtask.run(itr.lastInsertRowid, 'Computation', 2);
  insertSubtask.run(itr.lastInsertRowid, 'Return Filing', 3);
  insertSubtask.run(itr.lastInsertRowid, 'Acknowledgement Received', 4);

  insertSubtask.run(tds.lastInsertRowid, 'Q1 Filing', 1);
  insertSubtask.run(tds.lastInsertRowid, 'Q2 Filing', 2);
  insertSubtask.run(tds.lastInsertRowid, 'Q3 Filing', 3);
  insertSubtask.run(tds.lastInsertRowid, 'Q4 Filing', 4);

  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'midnight')").run();

  console.log('[DB] Default services and subtasks seeded.');
};

module.exports = { createTables, seedDefaults };
