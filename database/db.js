// SW.CA1 — Database Connection
// Opens the SQLite database and initializes schema on first run.

const path = require('path');
const fs   = require('fs');

let db;

const getDb = () => {
  if (db) return db;

  const config   = require('../config.json');
  const dbPath   = path.resolve(__dirname, '..', config.database.path);
  const dbDir    = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const Database = require('better-sqlite3');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const { createTables, seedDefaults } = require('./schema');
  createTables(db);
  seedDefaults(db);

  return db;
};

module.exports = { getDb };
