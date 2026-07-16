// server.js
// SW.CA1 — Main server
// Serves the dashboard and all API endpoints
// Updated M11.5 — adds conversation thread routes, filters outgoing from inbox
// Updated M11.6 — deadline_rules API, fixed PATCH /api/clients/:id (dynamic SET)
// Updated M11.7 — document checklist routes (GET/PATCH/POST /api/clients/:id/documents/:serviceId)
// Updated M11.8 — compliance overview route, subtask/doc route extensions,
//                 is_qrmp on PATCH /api/clients/:id, subtask_id on service_document_map
//                 PATCH /api/subtasks/:id — per-subtask frequency/due_day/due_month_offset

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const { initDatabase, getDb, saveDatabase } = require('./src/database');
const gmail    = require('./intake/gmail');
const {
  startPolling:          startWhatsAppPolling,
  startNewConnection,
  getConnectionStatus,
  cancelPendingConnection,
  listConnectedNumbers,
  disconnectNumber,
} = require('./intake/whatsapp');
const fetch    = require('node-fetch');
const os       = require('os');
const license         = require('./src/license');
const licenseActivate = require('./src/licenseActivate');

const app  = express();

// ── Config (Feature I — Multi-Device Support) ──────────────────────────────────
// Read once at startup from config.json. Falls back to safe defaults if the
// file is missing a key, so older config.json files still work unchanged.
let appConfig = {};
try {
  appConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
  console.warn('⚠️  Could not read config.json — using defaults (port 3000, network sharing on).');
}

const PORT            = (appConfig.app && appConfig.app.port) || 3000;
const NETWORK_ENABLED = appConfig.network ? appConfig.network.enabled !== false : true;
const REDIRECT_URI    = `http://localhost:${PORT}/api/gmail/callback`;

// ── License (Stage 1 — signed file + expiry, offline) ──────────────────────
const LICENSE_PATH    = (appConfig.license && appConfig.license.path)            || './license.json';
const LICENSE_CONTACT = (appConfig.license && appConfig.license.support_contact) || null;

// ── License (Stage 2 — optional remote early-revoke check) ─────────────────
// Leave firebase_url blank in config.json to skip this entirely — the app
// runs on Stage 1 (local expiry) alone until this is filled in.
const LICENSE_FIREBASE_URL   = (appConfig.license && appConfig.license.firebase_url) || null;
const LICENSE_REMOTE_HOURS   = (appConfig.license && appConfig.license.remote_check_hours) || 12;
const LICENSE_ACTIVATION_MAX_AGE_DAYS = (appConfig.license && appConfig.license.activation_code_max_age_days) || 60;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// GET /api/ping — lightweight connectivity check. Used by the dashboard's
// "Server Online" indicator so staff viewing over the office network can tell
// the main computer is still reachable.
app.get('/api/ping', (req, res) => {
  res.json({ ok: true });
});

// GET /api/license/status — used by the dashboard to show (or hide) the
// renewal banner. Never blocks itself — this route always responds, even
// when the license is restricted, so the dashboard can explain why.
app.get('/api/license/status', (req, res) => {
  res.json(license.getLicenseStatus());
});

// POST /api/license/activate — redeems a short activation code (typed by
// the CA firm into Settings) for the real signed license, fetched from
// Firebase and verified before being saved. This replaces manually
// copying a license.json file onto this computer. See
// src/licenseActivate.js for the full behavior and why each check exists.
app.post('/api/license/activate', async (req, res) => {
  const { code } = req.body || {};
  const result = await licenseActivate.activateWithCode(code, {
    firebaseUrl: LICENSE_FIREBASE_URL,
    licensePath: LICENSE_PATH,
    supportContact: LICENSE_CONTACT,
    maxAgeDays: LICENSE_ACTIVATION_MAX_AGE_DAYS,
  });
  res.json(result);
});

// ═════════════════════════════════════════════════════════════════════════════
// GMAIL ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/gmail/credentials — save Client ID + Secret from Settings UI
app.post('/api/gmail/credentials', (req, res) => {
  const { clientId, clientSecret } = req.body;
  if (!clientId || !clientSecret) {
    return res.status(400).json({ success: false, error: 'clientId and clientSecret are required' });
  }
  try {
    gmail.saveOAuthCredentials(clientId, clientSecret);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/gmail/credentials/status — check if credentials are saved
app.get('/api/gmail/credentials/status', (req, res) => {
  const creds = gmail.loadOAuthCredentials();
  res.json({ saved: !!creds });
});

// GET /api/gmail/connect — generate and return the Google OAuth URL
app.get('/api/gmail/connect', (req, res) => {
  try {
    const url = gmail.getAuthUrl(REDIRECT_URI);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gmail/callback — Google redirects here after user approves
app.get('/api/gmail/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code from Google.');
  }
  try {
    const email = await gmail.handleCallback(code, REDIRECT_URI);
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Gmail Connected</title>
          <style>
            body { font-family: sans-serif; display:flex; align-items:center;
                   justify-content:center; height:100vh; margin:0; background:#f0fdf4; }
            .box { text-align:center; padding:40px; background:white;
                   border-radius:12px; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
            h2 { color:#16a34a; margin-bottom:8px; }
            p  { color:#555; }
          </style>
        </head>
        <body>
          <div class="box">
            <h2>✅ Gmail Connected!</h2>
            <p><strong>${email}</strong> has been linked to SW.CA1.</p>
            <p>You can close this tab and return to the dashboard.</p>
          </div>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[Gmail] Callback error:', err);
    res.status(500).send(`
      <h2 style="color:red;font-family:sans-serif;text-align:center;margin-top:20vh">
        Connection failed: ${err.message}
      </h2>
      <p style="text-align:center;font-family:sans-serif">
        Please close this tab and try again from the Settings page.
      </p>
    `);
  }
});

// GET /api/gmail/accounts — list all connected Gmail accounts
app.get('/api/gmail/accounts', (req, res) => {
  try {
    const accounts = gmail.listConnectedAccounts();
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/gmail/accounts/:email — disconnect an account
app.delete('/api/gmail/accounts/:email', (req, res) => {
  try {
    const email   = decodeURIComponent(req.params.email);
    const removed = gmail.disconnectAccount(email);
    if (removed) {
      res.json({ success: true });
    } else {
      res.status(404).json({ success: false, error: 'Account not found' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start a new WhatsApp connection (triggers QR generation)
app.post('/api/whatsapp/connect', (req, res) => {
  const result = startNewConnection();
  res.json(result);
});

// Frontend polls this every 2 seconds to get QR and detect connection
app.get('/api/whatsapp/connect/status', (req, res) => {
  res.json(getConnectionStatus());
});

// Cancel a pending connection attempt
app.post('/api/whatsapp/connect/cancel', (req, res) => {
  cancelPendingConnection();
  res.json({ success: true });
});

// List all connected WhatsApp numbers
app.get('/api/whatsapp/accounts', (req, res) => {
  const numbers = listConnectedNumbers();
  const accounts = numbers.map(number => ({
    number,
    source: 'whatsapp',
    status: 'connected',
  }));
  res.json({ accounts });
});

// Disconnect a specific number
app.delete('/api/whatsapp/accounts/:number', async (req, res) => {
  try {
    await disconnectNumber(req.params.number);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MESSAGES / INBOX
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/messages — fetch all messages for the Inbox (newest first)
// Includes sender_phone and linked client info via client_sources join
app.get('/api/messages', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });

  try {
    const result = db.exec(`
      SELECT
        m.id,
        m.source,
        m.account,
        m.sender_name,
        m.sender_email,
        m.sender_phone,
        m.subject,
        m.category,
        m.urgency,
        m.ai_summary,
        m.attachment_count,
        m.received_at,
        c.id   AS linked_client_id,
        c.name AS linked_client_name
      FROM messages m
      LEFT JOIN client_sources cs ON (
        (m.source = 'gmail'    AND cs.type = 'email'    AND LOWER(cs.value) = LOWER(m.sender_email) AND m.sender_email IS NOT NULL AND m.sender_email != '')
        OR
        (m.source = 'whatsapp' AND cs.type = 'whatsapp' AND LOWER(cs.value) = LOWER(m.sender_phone) AND m.sender_phone IS NOT NULL AND m.sender_phone != '')
      )
      LEFT JOIN clients c ON c.id = cs.client_id
      WHERE (m.direction = 'incoming' OR m.direction IS NULL)
      ORDER BY m.received_at DESC
      LIMIT 200
    `);

    if (!result.length || !result[0].values.length) {
      return res.json({ messages: [] });
    }

    const cols = result[0].columns;
    const rows = result[0].values.map(row => {
      const obj = {};
      cols.forEach((col, i) => obj[col] = row[i]);
      return obj;
    });

    res.json({ messages: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/settings — get all settings
app.get('/api/settings', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`SELECT key, value FROM settings`);
    const settings = {};
    if (result.length) {
      result[0].values.forEach(([k, v]) => settings[k] = v);
    }
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings — save a setting key/value
app.post('/api/settings', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key is required' });
  try {
    db.run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, value]
    );
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENTS
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients
app.get('/api/clients', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`SELECT c.*, (SELECT COUNT(*) FROM attachments a JOIN messages m ON a.message_id = m.id JOIN client_sources cs ON LOWER(m.sender_email) = LOWER(cs.value) WHERE cs.client_id = c.id) AS attachment_count FROM clients c ORDER BY c.name ASC`);
    const clients = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients — returns id of newly created client
app.post('/api/clients', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { name, email, phone, gst_number, pan_number, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    db.run(
      `INSERT INTO clients (name, email, phone, gst_number, pan_number, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, email || '', phone || '', gst_number || '', pan_number || '', notes || '']
    );
    const idRow = db.exec(`SELECT last_insert_rowid()`);
    const newId = idRow[0].values[0][0];
    saveDatabase();
    res.json({ success: true, id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT SOURCES — MILESTONE 6
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients/:id/sources — list all linked sources for a client
app.get('/api/clients/:id/sources', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(
      `SELECT id, client_id, type, value, created_at
       FROM client_sources
       WHERE client_id = ?
       ORDER BY created_at ASC`,
      [req.params.id]
    );
    const sources = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/sources — link a source to a client
app.post('/api/clients/:id/sources', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { type, value } = req.body;
  if (!type || !value) return res.status(400).json({ error: 'type and value are required' });
  if (!['email', 'whatsapp'].includes(type)) return res.status(400).json({ error: 'type must be email or whatsapp' });
  try {
    db.run(
      `INSERT OR IGNORE INTO client_sources (client_id, type, value) VALUES (?, ?, ?)`,
      [req.params.id, type, value]
    );
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id/sources/:sourceId — unlink a source
app.delete('/api/clients/:id/sources/:sourceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    db.run(
      `DELETE FROM client_sources WHERE id = ? AND client_id = ?`,
      [req.params.sourceId, req.params.id]
    );
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/senders — unique senders from all messages (for Add Source picker)
app.get('/api/senders', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const emailRes = db.exec(`
      SELECT DISTINCT 'email' as type, sender_name, sender_email as value
      FROM messages
      WHERE source = 'gmail' AND sender_email IS NOT NULL AND sender_email != ''
      ORDER BY sender_name
    `);
    const waRes = db.exec(`
      SELECT DISTINCT 'whatsapp' as type, sender_name, sender_phone as value
      FROM messages
      WHERE source = 'whatsapp' AND sender_phone IS NOT NULL AND sender_phone != ''
      ORDER BY sender_name
    `);
    const senders = [];
    if (emailRes.length) {
      emailRes[0].values.forEach(r => senders.push({ type: r[0], sender_name: r[1], value: r[2] }));
    }
    if (waRes.length) {
      waRes[0].values.forEach(r => senders.push({ type: r[0], sender_name: r[1], value: r[2] }));
    }
    res.json({ senders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT TIMELINE — MILESTONE 7
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients/:id/messages — all messages linked to a client (for timeline)
app.get('/api/clients/:id/messages', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT DISTINCT
        m.id, m.source, m.account, m.sender_name, m.sender_email, m.sender_phone,
        m.subject, m.category, m.urgency, m.ai_summary, m.service_name,
        m.attachment_count, m.received_at
      FROM messages m
      JOIN client_sources cs ON (
        (m.source = 'gmail'    AND cs.type = 'email'    AND LOWER(cs.value) = LOWER(m.sender_email) AND m.sender_email IS NOT NULL AND m.sender_email != '')
        OR
        (m.source = 'whatsapp' AND cs.type = 'whatsapp' AND LOWER(cs.value) = LOWER(m.sender_phone) AND m.sender_phone IS NOT NULL AND m.sender_phone != '')
      )
      WHERE cs.client_id = ?
      ORDER BY m.received_at DESC
    `, [req.params.id]);

    const messages = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];

    // Attach filenames for each message
    if (messages.length) {
      const ids = messages.map(m => m.id).join(',');
      const attResult = db.exec(`
        SELECT message_id, filename, mime_type FROM attachments
        WHERE message_id IN (${ids}) ORDER BY id ASC
      `);
      const attMap = {};
      if (attResult.length) {
        attResult[0].values.forEach(([msgId, filename, mimeType]) => {
          if (!attMap[msgId]) attMap[msgId] = [];
          attMap[msgId].push({ filename, mimeType });
        });
      }
      messages.forEach(m => { m.attachments = attMap[m.id] || []; });
    }

    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/summary — consolidated AI overview (cached, refresh=1 to force)
app.get('/api/clients/:id/summary', async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const clientId = req.params.id;
  const force = req.query.refresh === '1';

  // Return cached summary unless forced refresh
  if (!force) {
    try {
      const cached = db.exec(`SELECT ai_summary, name FROM clients WHERE id = ?`, [clientId]);
      if (cached.length && cached[0].values.length) {
        const [existingSummary, name] = cached[0].values[0];
        if (existingSummary) return res.json({ summary: existingSummary, cached: true, clientName: name });
      }
    } catch (e) {}
  }

  // Fetch processed message summaries for this client
  try {
    const clientRow = db.exec(`SELECT name FROM clients WHERE id = ?`, [clientId]);
    const clientName = clientRow.length && clientRow[0].values.length ? clientRow[0].values[0][0] : 'this client';

    const msgResult = db.exec(`
      SELECT DISTINCT m.ai_summary, m.category, m.received_at
      FROM messages m
      JOIN client_sources cs ON (
        (m.source = 'gmail'    AND cs.type = 'email'    AND LOWER(cs.value) = LOWER(m.sender_email) AND m.sender_email IS NOT NULL)
        OR
        (m.source = 'whatsapp' AND cs.type = 'whatsapp' AND LOWER(cs.value) = LOWER(m.sender_phone) AND m.sender_phone IS NOT NULL)
      )
      WHERE cs.client_id = ? AND m.processed = 1 AND m.ai_summary IS NOT NULL AND m.ai_summary != ''
      ORDER BY m.received_at DESC LIMIT 30
    `, [clientId]);

    if (!msgResult.length || !msgResult[0].values.length) {
      return res.json({ summary: null, message: 'No processed messages yet' });
    }

    const lines = msgResult[0].values
      .map(([summary, category]) => `- ${category || 'Other'}: ${summary}`)
      .join('\n');

    let aiModel = 'gemma3:1b';
    try {
      const sr = db.exec(`SELECT value FROM settings WHERE key = 'ai_model'`);
      if (sr.length && sr[0].values.length) aiModel = sr[0].values[0][0] || aiModel;
    } catch (e) {}

    const prompt =
`You are a compliance assistant. Based on these recent message summaries for client "${clientName}", write a single paragraph (2–4 sentences) overview of their current compliance activity and any notable patterns or concerns.

Messages:
${lines}

Write ONLY the summary paragraph. No headers, no bullet points. Max 80 words.`;

    const response = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: aiModel, prompt, stream: false })
    });

    if (!response.ok) throw new Error('Ollama HTTP ' + response.status);
    const data = await response.json();
    const summary = (data.response || '').trim().substring(0, 600);

    db.run(`UPDATE clients SET ai_summary = ? WHERE id = ?`, [summary, clientId]);
    saveDatabase();

    res.json({ summary, cached: false, clientName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENTS — MILESTONE 7
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients/:id/payments
app.get('/api/clients/:id/payments', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT p.id, p.amount, p.method, p.notes, p.paid_at,
             COALESCE(s.name, p.service_name_snapshot) AS service_name
      FROM payments p
      LEFT JOIN services s ON s.id = p.service_id
      WHERE p.client_id = ?
      ORDER BY p.paid_at DESC
    `, [req.params.id]);
    const payments = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ payments });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/payments
app.post('/api/clients/:id/payments', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { amount, method, notes, paid_at, service_name } = req.body;
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'valid amount is required' });
  try {
    let serviceId = null;
    if (service_name) {
      const sr = db.exec(`SELECT id FROM services WHERE name = ?`, [service_name]);
      if (sr.length && sr[0].values.length) serviceId = sr[0].values[0][0];
    }
    db.run(
      `INSERT INTO payments (client_id, service_id, amount, method, notes, paid_at, service_name_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.params.id, serviceId, parseFloat(amount), method || 'Other', notes || '', paid_at || new Date().toISOString(), service_name || null]
    );
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SERVICES — list and create
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/services', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`SELECT id, name, is_default FROM services ORDER BY name`);
    const services = result.length
      ? result[0].values.map(row => ({ id: row[0], name: row[1], is_default: row[2] }))
      : [];
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/services', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { name, subtasks } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    db.run(`INSERT OR IGNORE INTO services (name) VALUES (?)`, [name]);
    const idRow = db.exec(`SELECT id FROM services WHERE name = ?`, [name]);
    const serviceId = idRow[0].values[0][0];
    // Insert subtasks
    if (Array.isArray(subtasks)) {
      subtasks.forEach((st, i) => {
        db.run(`INSERT OR IGNORE INTO subtasks (service_id, name, sort_order) VALUES (?, ?, ?)`, [serviceId, st, i]);
      });
    }
    saveDatabase();
    res.json({ success: true, id: serviceId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/:serviceId/delete-impact — counts to show on a
// confirmation screen BEFORE deleting a service, so the CA can see exactly
// what's affected first. Read-only, nothing is changed.
app.get('/api/services/:serviceId/delete-impact', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const svcRes = db.exec(`SELECT name, is_default FROM services WHERE id = ?`, [req.params.serviceId]);
    if (!svcRes.length || !svcRes[0].values.length) return res.status(404).json({ error: 'Service not found' });
    const [name, isDefault] = svcRes[0].values[0];

    const count = (sql) => {
      const r = db.exec(sql, [req.params.serviceId]);
      return (r.length && r[0].values.length) ? (r[0].values[0][0] || 0) : 0;
    };

    res.json({
      success:               true,
      service_name:          name,
      is_default:            !!isDefault,
      client_count:          count(`SELECT COUNT(*) FROM client_services WHERE service_id = ?`),
      subtask_count:         count(`SELECT COUNT(*) FROM subtasks WHERE service_id = ?`),
      subtask_status_count:  count(`SELECT COUNT(*) FROM client_subtask_status WHERE subtask_id IN (SELECT id FROM subtasks WHERE service_id = ?)`),
      document_map_count:    count(`SELECT COUNT(*) FROM service_document_map WHERE service_id = ?`),
      document_status_count: count(`SELECT COUNT(*) FROM document_checklist_status WHERE service_id = ?`),
      payment_count:         count(`SELECT COUNT(*) FROM payments WHERE service_id = ?`),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/services/:serviceId — removes a service and everything that
// only exists to describe or track work FOR it. Default services (GST,
// ITR, TDS) are permanently protected and cannot be deleted this way.
//
// Financial history (payments) is deliberately NEVER deleted — the
// service's name is stamped onto every payment referencing it first (see
// payments.service_name_snapshot), then service_id is detached, so the
// amount/date/notes/label all survive even though the service is gone.
//
// timeline.service_name, messages.service_name, and threads.service_tag are
// plain saved text already, not live links to this row — left untouched on
// purpose so past communication history keeps reading correctly forever.
app.delete('/api/services/:serviceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const svcRes = db.exec(`SELECT name, is_default FROM services WHERE id = ?`, [req.params.serviceId]);
    if (!svcRes.length || !svcRes[0].values.length) return res.status(404).json({ error: 'Service not found' });
    const [name, isDefault] = svcRes[0].values[0];

    if (isDefault) {
      return res.status(403).json({ error: 'Default services (GST, ITR, TDS) are protected and cannot be deleted.' });
    }

    // 1. Preserve financial history — stamp the name, then detach the link.
    db.run(`UPDATE payments SET service_name_snapshot = ?, service_id = NULL WHERE service_id = ?`, [name, req.params.serviceId]);

    // 2. Pure configuration/tracking data — safe to remove outright.
    db.run(`DELETE FROM client_subtask_status WHERE subtask_id IN (SELECT id FROM subtasks WHERE service_id = ?)`, [req.params.serviceId]);
    db.run(`DELETE FROM subtasks WHERE service_id = ?`, [req.params.serviceId]);
    db.run(`DELETE FROM service_document_map WHERE service_id = ?`, [req.params.serviceId]);
    db.run(`DELETE FROM document_checklist_status WHERE service_id = ?`, [req.params.serviceId]);
    db.run(`DELETE FROM deadline_rules WHERE service_id = ?`, [req.params.serviceId]);
    db.run(`DELETE FROM client_services WHERE service_id = ?`, [req.params.serviceId]);
    db.run(`DELETE FROM services WHERE id = ?`, [req.params.serviceId]);

    saveDatabase();
    res.json({ success: true, service_name: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SUBTASKS — MILESTONE 8
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/subtasks?service_name=X — list subtask definitions for a service (M11)
app.get('/api/subtasks', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { service_name } = req.query;
  if (!service_name) return res.status(400).json({ error: 'service_name query param required' });
  try {
    const result = db.exec(`
      SELECT st.id, st.name, st.sort_order, st.frequency, st.due_day, st.due_month_offset, st.alert_days
      FROM subtasks st
      JOIN services sv ON sv.id = st.service_id
      WHERE sv.name = ?
      ORDER BY st.sort_order
    `, [service_name]);
    const subtasks = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ subtasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/subtasks/:id — update a subtask definition's per-subtask deadline fields (M11.8/M12)
// Body: { frequency, due_day, due_month_offset, alert_days } — only the keys present in the body are updated.
// Pass '' or null for a field to clear it back to NULL (unset).
//   frequency:         'monthly' | 'quarterly' | 'annual' | '' (any/unset)
//   due_day:           1–31, day of month this subtask is individually due
//   due_month_offset:  0–11, how many months after the period end the due_day falls
//   alert_days:        1–30, how many days before THIS subtask's own due date to flag
//                       it as deadline_alert / fire a Smart Alert (M12). Falls back to
//                       the service's own alert_days (or 3) when unset.
// Used by Settings → Service Configuration → Subtask Deadlines (M11.8 + M12).
// Does not touch client_subtask_status — this edits the subtask definition itself,
// which applies to every client assigned that service.
app.patch('/api/subtasks/:id', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { frequency, due_day, due_month_offset, alert_days } = req.body;

  const validFreq = ['monthly', 'quarterly', 'annual'];
  if (frequency !== undefined && frequency !== '' && frequency !== null && !validFreq.includes(frequency)) {
    return res.status(400).json({ error: 'frequency must be monthly, quarterly, annual, or empty' });
  }
  if (due_day !== undefined && due_day !== '' && due_day !== null) {
    const d = parseInt(due_day);
    if (isNaN(d) || d < 1 || d > 31) return res.status(400).json({ error: 'due_day must be between 1 and 31' });
  }
  if (due_month_offset !== undefined && due_month_offset !== '' && due_month_offset !== null) {
    const m = parseInt(due_month_offset);
    if (isNaN(m) || m < 0 || m > 11) return res.status(400).json({ error: 'due_month_offset must be between 0 and 11' });
  }
  if (alert_days !== undefined && alert_days !== '' && alert_days !== null) {
    const a = parseInt(alert_days);
    if (isNaN(a) || a < 1 || a > 30) return res.status(400).json({ error: 'alert_days must be between 1 and 30' });
  }

  try {
    const sets = [], vals = [];
    if (frequency !== undefined) { sets.push('frequency = ?'); vals.push(frequency || null); }
    if (due_day !== undefined)  { sets.push('due_day = ?');  vals.push(due_day === '' || due_day === null ? null : parseInt(due_day)); }
    if (due_month_offset !== undefined) { sets.push('due_month_offset = ?'); vals.push(due_month_offset === '' || due_month_offset === null ? null : parseInt(due_month_offset)); }
    if (alert_days !== undefined) { sets.push('alert_days = ?'); vals.push(alert_days === '' || alert_days === null ? null : parseInt(alert_days)); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    vals.push(req.params.id);
    db.run(`UPDATE subtasks SET ${sets.join(', ')} WHERE id = ?`, vals);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:clientId/services/:serviceId/period — manually set
// which period a client's service is currently on.
//
// Periods normally only move FORWARD, via the deadline engine's auto-advance
// (once all of a period's subtasks are Done). There was previously no way
// to move one backward or jump it — needed e.g. after resetting a client's
// subtask statuses for testing/troubleshooting, or correcting a client who
// auto-advanced prematurely. Per the blueprint, overriding the period is
// meant to stay a deliberate, manual CA action — this route is that action.
//
// Body: { period, rule_type_override? }
//   period — must match the EFFECTIVE cadence's format (see below):
//     monthly:   "YYYY-MM"        e.g. 2026-06
//     quarterly: "YYYY-Q#"        e.g. 2026-Q1
//     annual:    "FY-YYYY-YY"     e.g. FY-2026-27
//   rule_type_override — OPTIONAL. Lets this ONE client run this service on a
//     different cadence than the service's own default (e.g. a QRMP client on
//     quarterly GST while everyone else stays monthly). Pass 'monthly' /
//     'quarterly' / 'annual' to set it, or null / '' to clear it back to
//     "use the service's own default". Omit the field entirely to leave
//     whatever override is already saved untouched — this keeps old callers
//     that only ever sent { period } working exactly as before.
//   The "effective cadence" used to validate `period` is: an override sent in
//   THIS request, else an override already saved on the client+service, else
//   the service's own deadline_rules.rule_type. due_day/due_month are never
//   overridden — those still come from the service's own deadline_rules.
//   reset_subtasks — OPTIONAL boolean, default false. When true, every
//     standard subtask for this client+service whose frequency matches the
//     effective cadence (or has no frequency set) is reset to Pending —
//     the same fixed logic the auto-advance engine uses, so a client
//     manually moved to a new period doesn't carry over sub-step statuses
//     that belonged to the old one. Logged to the client's timeline.
app.patch('/api/clients/:clientId/services/:serviceId/period', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { period } = req.body;
  const resetSubtasks = req.body.reset_subtasks === true;
  const overrideProvided = Object.prototype.hasOwnProperty.call(req.body, 'rule_type_override');
  let ruleTypeOverride = overrideProvided ? req.body.rule_type_override : undefined;
  if (ruleTypeOverride === '') ruleTypeOverride = null; // a "Use service default" <select> option clears it

  if (!period || typeof period !== 'string') return res.status(400).json({ error: 'period is required' });

  const validTypes = ['monthly', 'quarterly', 'annual'];
  if (overrideProvided && ruleTypeOverride !== null && !validTypes.includes(ruleTypeOverride)) {
    return res.status(400).json({ error: 'rule_type_override must be monthly, quarterly, annual, or null' });
  }

  try {
    const assigned = db.exec(
      `SELECT rule_type_override FROM client_services WHERE client_id = ? AND service_id = ?`,
      [req.params.clientId, req.params.serviceId]
    );
    if (!assigned.length || !assigned[0].values.length) {
      return res.status(404).json({ error: 'Client is not assigned this service' });
    }
    const existingOverride = assigned[0].values[0][0];

    const svcRes = db.exec(`SELECT name FROM services WHERE id = ?`, [req.params.serviceId]);
    const serviceName = (svcRes.length && svcRes[0].values.length) ? svcRes[0].values[0][0] : 'Service';

    const ruleRes = db.exec(`SELECT rule_type FROM deadline_rules WHERE service_id = ?`, [req.params.serviceId]);
    const serviceRuleType = (ruleRes.length && ruleRes[0].values.length) ? ruleRes[0].values[0][0] : null;

    // Effective cadence for validating the period string this request is saving.
    const effectiveOverride    = overrideProvided ? ruleTypeOverride : existingOverride;
    const ruleTypeForValidation = effectiveOverride || serviceRuleType;

    const patterns = {
      monthly:   { re: /^\d{4}-(0[1-9]|1[0-2])$/,     example: '2026-06' },
      quarterly: { re: /^\d{4}-Q[1-4]$/,               example: '2026-Q1' },
      annual:    { re: /^FY-\d{4}-\d{2,4}$/,           example: 'FY-2026-27' },
    };

    if (ruleTypeForValidation && patterns[ruleTypeForValidation]) {
      if (!patterns[ruleTypeForValidation].re.test(period)) {
        return res.status(400).json({
          error: `period must match this client's ${ruleTypeForValidation} format, e.g. "${patterns[ruleTypeForValidation].example}"`
        });
      }
    } else if (!Object.values(patterns).some(p => p.re.test(period))) {
      return res.status(400).json({ error: 'period format not recognized — expected YYYY-MM, YYYY-Q#, or FY-YYYY-YY' });
    }

    if (overrideProvided) {
      db.run(
        `UPDATE client_services SET current_period = ?, rule_type_override = ? WHERE client_id = ? AND service_id = ?`,
        [period, ruleTypeOverride, req.params.clientId, req.params.serviceId]
      );
    } else {
      db.run(
        `UPDATE client_services SET current_period = ? WHERE client_id = ? AND service_id = ?`,
        [period, req.params.clientId, req.params.serviceId]
      );
    }

    if (resetSubtasks) {
      db.run(`
        UPDATE client_subtask_status
        SET    status = 'Pending', updated_at = CURRENT_TIMESTAMP
        WHERE  client_id = ?
          AND  subtask_id IN (
                 SELECT id FROM subtasks
                 WHERE service_id = ? AND client_id IS NULL
                   AND (frequency IS NULL OR frequency = ?)
               )
      `, [req.params.clientId, req.params.serviceId, ruleTypeForValidation]);

      const ts = new Date().toISOString();
      db.run(`
        INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
        VALUES (?, 'system', ?, ?, ?, ?)
      `, [req.params.clientId, `${serviceName} period manually changed to ${period} — subtask statuses reset`, ts, serviceName, ts]);
    }

    saveDatabase();
    res.json({ success: true, period, rule_type_override: overrideProvided ? ruleTypeOverride : existingOverride, reset_subtasks: resetSubtasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/services/:serviceId/period/bulk — set the period for every
// client assigned to a service in one action, instead of one client at a time.
//
// Deliberately only ever touches clients on the SERVICE'S OWN default
// cadence (rule_type_override IS NULL). Clients with a per-client override
// (e.g. a QRMP client running quarterly while the service default is
// monthly) are never swept along — the whole point of the override is that
// they need a different-shaped period string, which this bulk action isn't
// built to author. Those clients are always listed back as "excluded" so
// the CA can see who was skipped and go handle them individually from the
// Compliance Overview side panel.
//
// Body: { period, reset_subtasks?, dry_run? }
//   period          — required, must match the SERVICE's own rule_type format.
//   reset_subtasks  — optional boolean, default false. Same fixed,
//                      frequency-filtered reset used by the single-client
//                      route and the auto-advance engine.
//   dry_run         — optional boolean, default false. When true, nothing is
//                      written — just returns who WOULD change and who WOULD
//                      be excluded, so the UI can show a preview before the
//                      CA commits. This is the same endpoint for preview and
//                      apply so the two can never drift out of sync.
app.post('/api/services/:serviceId/period/bulk', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { period } = req.body;
  const resetSubtasks = req.body.reset_subtasks === true;
  const dryRun        = req.body.dry_run === true;
  if (!period || typeof period !== 'string') return res.status(400).json({ error: 'period is required' });

  try {
    const svcRes = db.exec(`SELECT name FROM services WHERE id = ?`, [req.params.serviceId]);
    if (!svcRes.length || !svcRes[0].values.length) return res.status(404).json({ error: 'Service not found' });
    const serviceName = svcRes[0].values[0][0];

    const ruleRes = db.exec(`SELECT rule_type FROM deadline_rules WHERE service_id = ?`, [req.params.serviceId]);
    const serviceRuleType = (ruleRes.length && ruleRes[0].values.length) ? ruleRes[0].values[0][0] : null;

    const patterns = {
      monthly:   { re: /^\d{4}-(0[1-9]|1[0-2])$/,     example: '2026-06' },
      quarterly: { re: /^\d{4}-Q[1-4]$/,               example: '2026-Q1' },
      annual:    { re: /^FY-\d{4}-\d{2,4}$/,           example: 'FY-2026-27' },
    };
    if (serviceRuleType && patterns[serviceRuleType]) {
      if (!patterns[serviceRuleType].re.test(period)) {
        return res.status(400).json({
          error: `period must match this service's ${serviceRuleType} format, e.g. "${patterns[serviceRuleType].example}"`
        });
      }
    } else if (!Object.values(patterns).some(p => p.re.test(period))) {
      return res.status(400).json({ error: 'period format not recognized — expected YYYY-MM, YYYY-Q#, or FY-YYYY-YY' });
    }

    const rowsRes = db.exec(`
      SELECT c.id AS client_id, c.name AS client_name,
             cs.current_period, cs.rule_type_override
      FROM   client_services cs
      JOIN   clients c ON c.id = cs.client_id
      WHERE  cs.service_id = ?
      ORDER BY c.name ASC
    `, [req.params.serviceId]);

    const rows = (rowsRes.length && rowsRes[0].values.length)
      ? rowsRes[0].values.map(v => ({ client_id: v[0], client_name: v[1], current_period: v[2], rule_type_override: v[3] }))
      : [];

    const eligible = rows.filter(r => !r.rule_type_override).map(r => ({ client_id: r.client_id, client_name: r.client_name, current_period: r.current_period }));
    const excluded = rows.filter(r => !!r.rule_type_override).map(r => ({ client_id: r.client_id, client_name: r.client_name, current_period: r.current_period, rule_type_override: r.rule_type_override }));

    if (dryRun) {
      return res.json({ success: true, dry_run: true, period, eligible, excluded });
    }

    const ts = new Date().toISOString();
    for (const r of eligible) {
      db.run(`UPDATE client_services SET current_period = ? WHERE client_id = ? AND service_id = ?`, [period, r.client_id, req.params.serviceId]);

      if (resetSubtasks) {
        db.run(`
          UPDATE client_subtask_status
          SET    status = 'Pending', updated_at = CURRENT_TIMESTAMP
          WHERE  client_id = ?
            AND  subtask_id IN (
                   SELECT id FROM subtasks
                   WHERE service_id = ? AND client_id IS NULL
                     AND (frequency IS NULL OR frequency = ?)
                 )
        `, [r.client_id, req.params.serviceId, serviceRuleType]);
      }

      db.run(`
        INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
        VALUES (?, 'system', ?, ?, ?, ?)
      `, [r.client_id, `${serviceName} period bulk-set to ${period}${resetSubtasks ? ' — subtask statuses reset' : ''}`, ts, serviceName, ts]);
    }

    saveDatabase();
    res.json({ success: true, period, changed_count: eligible.length, excluded_count: excluded.length, eligible, excluded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/clients/:id/subtasks — load all subtask statuses for a client
app.get('/api/clients/:id/subtasks', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT st.id, st.name, st.sort_order, sv.name AS service_name,
             st.frequency, st.due_day, st.due_month_offset,
             COALESCE(css.status, 'Pending') AS status
      FROM subtasks st
      JOIN services sv ON sv.id = st.service_id
      LEFT JOIN client_subtask_status css ON css.subtask_id = st.id AND css.client_id = ?
      WHERE (st.client_id IS NULL OR st.client_id = ?)
      ORDER BY sv.name, st.sort_order
    `, [req.params.id, req.params.id]);
    const subtasks = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ subtasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id/subtasks/:subtaskId — save subtask status
app.patch('/api/clients/:id/subtasks/:subtaskId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { status } = req.body;
  const allowed = ['Pending', 'In Progress', 'Done'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    // M12 — conflict detection. If this exact (client, subtask) row was
    // updated within the last CONFLICT_WINDOW_SECONDS to a DIFFERENT status
    // than what's being set now, two people likely edited it within moments
    // of each other via two browser tabs against the one live database (the
    // narrower scenario Feature H's notification list was reworded to match
    // under M14's single-server model). Still applies this write — last
    // write wins — just flags the clash so the CA can double-check.
    const CONFLICT_WINDOW_SECONDS = 15;
    try {
      const prevRow = db.exec(`
        SELECT css.status, css.updated_at, st.service_id, st.name
        FROM client_subtask_status css
        JOIN subtasks st ON st.id = css.subtask_id
        WHERE css.client_id = ? AND css.subtask_id = ?
      `, [req.params.id, req.params.subtaskId]);
      if (prevRow.length && prevRow[0].values.length) {
        const [prevStatus, prevUpdatedAt, serviceId, subtaskName] = prevRow[0].values[0];
        const secondsSince = prevUpdatedAt ? (new Date() - new Date(prevUpdatedAt)) / 1000 : Infinity;
        if (prevStatus !== status && secondsSince >= 0 && secondsSince < CONFLICT_WINDOW_SECONDS) {
          db.run(`
            INSERT INTO notifications (type, client_id, service_id, subtask_id, message, status)
            VALUES ('conflict_detected', ?, ?, ?, ?, 'active')
          `, [req.params.id, serviceId, req.params.subtaskId,
              `${subtaskName} — set to "${prevStatus}" and "${status}" within seconds of each other. Please confirm the correct status.`]);
        }
      }
    } catch (e) { console.error('[Alerts] Conflict check (subtask) error:', e.message); }

    db.run(`
      INSERT INTO client_subtask_status (client_id, subtask_id, status, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(client_id, subtask_id) DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP
    `, [req.params.id, req.params.subtaskId, status]);

    // Auto-generate timeline entry
    const stRow = db.exec(`
      SELECT st.name, sv.name AS service_name
      FROM subtasks st
      JOIN services sv ON sv.id = st.service_id
      WHERE st.id = ?
    `, [req.params.subtaskId]);
    if (stRow.length && stRow[0].values.length) {
      const [subtaskName, serviceName] = stRow[0].values[0];
      const now = new Date().toISOString();
      const content = `${subtaskName} marked ${status}${serviceName ? ' (' + serviceName + ')' : ''}`;
      db.run(`
        INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
        VALUES (?, 'system', ?, ?, ?, ?)
      `, [req.params.id, content, now, serviceName, now]);
    }

    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subtasks/mass-update — M11: bulk status update across multiple clients
app.post('/api/subtasks/mass-update', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { client_ids, subtask_id, status, subtask_name, service_name } = req.body;
  const allowed = ['Pending', 'In Progress', 'Done'];
  if (!Array.isArray(client_ids) || !client_ids.length)
    return res.status(400).json({ error: 'client_ids array required' });
  if (!subtask_id)
    return res.status(400).json({ error: 'subtask_id required' });
  if (!allowed.includes(status))
    return res.status(400).json({ error: 'Invalid status — must be Pending, In Progress, or Done' });
  try {
    const now = new Date().toISOString();
    const label = subtask_name || 'Subtask';
    const svcLabel = service_name || null;
    const content = `${label} marked ${status}${svcLabel ? ' (' + svcLabel + ')' : ''}`;
    for (const clientId of client_ids) {
      // Upsert status
      db.run(`
        INSERT INTO client_subtask_status (client_id, subtask_id, status, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(client_id, subtask_id)
        DO UPDATE SET status = excluded.status, updated_at = CURRENT_TIMESTAMP
      `, [clientId, subtask_id, status]);
      // Auto-generate timeline entry (same mechanism as M10)
      db.run(`
        INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
        VALUES (?, 'system', ?, ?, ?, ?)
      `, [clientId, content, now, svcLabel, now]);
    }
    saveDatabase();
    res.json({ success: true, updated: client_ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/messages/:id/create-task — M10.5: create subtask from inbox message
app.post('/api/messages/:id/create-task', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const messageId = parseInt(req.params.id);
  const { client_id, service_name, subtask_name, due_date } = req.body;
  if (!client_id || !service_name || !subtask_name)
    return res.status(400).json({ error: 'client_id, service_name, and subtask_name are required' });
  try {
    const sr = db.exec(`SELECT id FROM services WHERE name = ?`, [service_name]);
    if (!sr.length || !sr[0].values.length)
      return res.status(404).json({ error: 'Service not found' });
    const serviceId = sr[0].values[0][0];
    db.run(
      `INSERT INTO subtasks (service_id, name, sort_order, source_message_id, client_id) VALUES (?, ?, 0, ?, ?)`,
      [serviceId, subtask_name, messageId, client_id]
    );
    const idRow = db.exec(`SELECT last_insert_rowid()`);
    const subtaskId = idRow[0].values[0][0];
    db.run(
      `INSERT OR IGNORE INTO client_subtask_status (client_id, subtask_id, status, updated_at)
       VALUES (?, ?, 'Pending', CURRENT_TIMESTAMP)`,
      [client_id, subtaskId]
    );
    const content = `Task created: ${subtask_name}${due_date ? ' — due ' + due_date : ''}`;
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
      VALUES (?, 'system', ?, ?, ?, ?)`,
     [client_id, content, now, service_name, now]
    );
    saveDatabase();
    res.json({ success: true, subtask_id: subtaskId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// TIMELINE (SYSTEM ENTRIES) — MILESTONE 8
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients/:id/timeline — messages + system entries combined
app.get('/api/clients/:id/timeline', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    // System/manual timeline entries
    const sysResult = db.exec(`
      SELECT id, entry_type, content, entry_date, created_at, service_name
      FROM timeline
      WHERE client_id = ? AND (entry_type = 'system' OR entry_type = 'note')
      ORDER BY COALESCE(entry_date, created_at) DESC, created_at DESC
    `, [req.params.id]);
    const sysEntries = sysResult.length
      ? sysResult[0].values.map(row => {
          const obj = {};
          sysResult[0].columns.forEach((c, i) => obj[c] = row[i]);
          obj._kind = 'system';
          return obj;
        })
      : [];
    res.json({ entries: sysEntries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/timeline — create a system timeline entry
app.post('/api/clients/:id/timeline', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { content, entry_date, entry_type, service_name } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  try {
    const now = new Date().toISOString();
    db.run(`
      INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [req.params.id, entry_type || 'system', content, entry_date || now, service_name || null, now]);
    const idRow = db.exec(`SELECT last_insert_rowid()`);
    const newId = idRow[0].values[0][0];
    saveDatabase();
    res.json({ success: true, id: newId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id/timeline/:entryId — edit a system timeline entry
app.patch('/api/clients/:id/timeline/:entryId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { content, entry_date } = req.body;
  try {
    db.run(`
      UPDATE timeline SET content = ?, entry_date = ?
      WHERE id = ? AND client_id = ? AND entry_type != 'message'
    `, [content, entry_date, req.params.entryId, req.params.id]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id/timeline/:entryId — delete a system timeline entry
app.delete('/api/clients/:id/timeline/:entryId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    db.run(`DELETE FROM timeline WHERE id = ? AND client_id = ? AND entry_type != 'message'`,
      [req.params.entryId, req.params.id]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENTS EDIT/DELETE — MILESTONE 8
// ═════════════════════════════════════════════════════════════════════════════

// PATCH /api/clients/:id/payments/:paymentId
app.patch('/api/clients/:id/payments/:paymentId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { amount, method, notes, paid_at, service_name } = req.body;
  if (!amount || isNaN(parseFloat(amount))) return res.status(400).json({ error: 'valid amount required' });
  try {
    let serviceId = null;
    if (service_name) {
      const sr = db.exec(`SELECT id FROM services WHERE name = ?`, [service_name]);
      if (sr.length && sr[0].values.length) serviceId = sr[0].values[0][0];
    }
    db.run(`
      UPDATE payments SET amount = ?, method = ?, notes = ?, paid_at = ?, service_id = ?, service_name_snapshot = ?
      WHERE id = ? AND client_id = ?
    `, [parseFloat(amount), method || 'Other', notes || '', paid_at, serviceId, service_name || null, req.params.paymentId, req.params.id]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id/payments/:paymentId
app.delete('/api/clients/:id/payments/:paymentId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    db.run(`DELETE FROM payments WHERE id = ? AND client_id = ?`, [req.params.paymentId, req.params.id]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT FIELDS (next_deadline, filing_date, deadline_override_flag) — M8 / M11.6
// ═════════════════════════════════════════════════════════════════════════════

// PATCH /api/clients/:id — update any combination of deadline/filing/override fields
//
// M11.6 fix: the previous version always wrote both next_deadline AND filing_date
// even if only one was sent, clearing the other field. Now uses dynamic SET building
// so only fields present in the request body are touched.
//
// Accepted body fields (all optional — send only what you want to change):
//   next_deadline          TEXT   — ISO date string or null
//   filing_date            TEXT   — ISO date string or null
//   deadline_override_flag INTEGER — 1 = CA set manually, 0 = reset to auto
app.patch('/api/clients/:id', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { next_deadline, filing_date, deadline_override_flag, is_qrmp, contact_alert_days } = req.body;
  try {
    const sets = ['updated_at = CURRENT_TIMESTAMP'];
    const vals = [];

    if (next_deadline !== undefined) {
      sets.push('next_deadline = ?');
      vals.push(next_deadline || null);
    }
    if (filing_date !== undefined) {
      sets.push('filing_date = ?');
      vals.push(filing_date || null);
    }
    if (deadline_override_flag !== undefined) {
      sets.push('deadline_override_flag = ?');
      vals.push(deadline_override_flag ? 1 : 0);
    }
    if (is_qrmp !== undefined) {
      sets.push('is_qrmp = ?');
      vals.push(is_qrmp ? 1 : 0);
    }
    if (contact_alert_days !== undefined) {
      // M12 — "Client not contacted" threshold, per client. Null/blank clears
      // the override so the alert engine falls back to the global default
      // (settings.default_contact_alert_days).
      sets.push('contact_alert_days = ?');
      vals.push(contact_alert_days === null || contact_alert_days === '' ? null : parseInt(contact_alert_days, 10));
    }

    vals.push(req.params.id);
    db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, vals);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DEADLINE RULES — MILESTONE 11.6
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/deadline-rules — list all services with their deadline rules
// Services without a rule are included (rule fields will be null).
// Used by the Settings UI to render the Deadline Rules section.
app.get('/api/deadline-rules', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT s.id   AS service_id,
             s.name AS service_name,
             dr.id  AS rule_id,
             dr.rule_type,
             dr.due_day,
             dr.due_month,
             dr.alert_days
      FROM   services s
      LEFT JOIN deadline_rules dr ON dr.service_id = s.id
      ORDER BY s.name ASC
    `);
    const rules = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deadline-rules/:serviceId — create or update a rule for a service
// Body: { rule_type, due_day, due_month?, alert_days? }
// Uses INSERT … ON CONFLICT DO UPDATE so it works whether the row exists or not.
app.post('/api/deadline-rules/:serviceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { rule_type, due_day, due_month, alert_days } = req.body;

  const validTypes = ['monthly', 'quarterly', 'annual'];
  if (!validTypes.includes(rule_type))
    return res.status(400).json({ error: 'rule_type must be monthly, quarterly, or annual' });
  if (!due_day || due_day < 1 || due_day > 31)
    return res.status(400).json({ error: 'due_day must be between 1 and 31' });

  try {
    db.run(`
      INSERT INTO deadline_rules (service_id, rule_type, due_day, due_month, alert_days)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET
        rule_type  = excluded.rule_type,
        due_day    = excluded.due_day,
        due_month  = excluded.due_month,
        alert_days = excluded.alert_days
    `, [req.params.serviceId, rule_type, parseInt(due_day), due_month || null, parseInt(alert_days) || 3]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT SERVICES (add/remove on existing clients) — MILESTONE 8
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients/:id/services
app.get('/api/clients/:id/services', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT s.id, s.name, cs.status, cs.current_period
      FROM client_services cs
      JOIN services s ON s.id = cs.service_id
      WHERE cs.client_id = ?
      ORDER BY s.name
    `, [req.params.id]);
    const services = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/services — assign a service to a client
app.post('/api/clients/:id/services', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { service_name } = req.body;
  if (!service_name) return res.status(400).json({ error: 'service_name required' });
  try {
    const sr = db.exec(`SELECT id FROM services WHERE name = ?`, [service_name]);
    if (!sr.length || !sr[0].values.length) return res.status(404).json({ error: 'Service not found' });
    const serviceId = sr[0].values[0][0];
    db.run(`INSERT OR IGNORE INTO client_services (client_id, service_id) VALUES (?, ?)`,
      [req.params.id, serviceId]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/clients/:id/services/:serviceId
app.delete('/api/clients/:id/services/:serviceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    db.run(`DELETE FROM client_services WHERE client_id = ? AND service_id = ?`,
      [req.params.id, req.params.serviceId]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SERVICE DOCUMENT MAPPINGS — MILESTONE 8
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/services/:id/documents
app.get('/api/services/:id/documents', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`SELECT id, doc_type, subtask_id FROM service_document_map WHERE service_id = ?`, [req.params.id]);
    const docs = result.length
      ? result[0].values.map(row => ({ id: row[0], doc_type: row[1], subtask_id: row[2] }))
      : [];
    res.json({ docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/services/:id/documents — add document types for a service
app.post('/api/services/:id/documents', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { doc_types } = req.body; // array of strings
  if (!Array.isArray(doc_types) || !doc_types.length) return res.status(400).json({ error: 'doc_types array required' });
  try {
    doc_types.forEach(dt => {
      db.run(`INSERT OR IGNORE INTO service_document_map (service_id, doc_type) VALUES (?, ?)`,
        [req.params.id, dt.trim()]);
    });
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/services/:id/documents/:docId — remove a single document mapping
app.delete('/api/services/:id/documents/:docId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    db.run(`DELETE FROM service_document_map WHERE id = ? AND service_id = ?`,
      [req.params.docId, req.params.id]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/services/:id/documents/:docId — update the subtask_id link for a document
// Body: { subtask_id } — pass null to unlink the document from any subtask.
// Used by Settings → Service Configuration when the CA links a doc to a subtask (M11.8).
app.patch('/api/services/:id/documents/:docId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { subtask_id } = req.body;
  try {
    db.run(
      `UPDATE service_document_map SET subtask_id = ? WHERE id = ? AND service_id = ?`,
      [subtask_id || null, req.params.docId, req.params.id]
    );
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// DOCUMENT CHECKLIST — MILESTONE 11.7
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/clients/:id/documents/:serviceId?period=X
// Returns all expected documents for this service merged with checklist status.
// Standard docs come from service_document_map LEFT JOINed with checklist records.
// Documents without a checklist record get status='pending', checklist_id=null.
// One-off docs added by the CA (not in service_document_map) come back in `extras`.
app.get('/api/clients/:id/documents/:serviceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { period } = req.query;
  if (!period) return res.status(400).json({ error: 'period query param required' });
  try {
    const docsResult = db.exec(`
      SELECT sdm.id    AS sdm_id,
             sdm.doc_type,
             dcs.id    AS checklist_id,
             COALESCE(dcs.status, 'pending') AS status,
             dcs.received_at,
             dcs.source_message_id,
             COALESCE(dcs.manually_set, 0)   AS manually_set
      FROM service_document_map sdm
      LEFT JOIN document_checklist_status dcs
        ON  dcs.client_id  = ?
        AND dcs.service_id = ?
        AND dcs.period     = ?
        AND LOWER(dcs.doc_type) = LOWER(sdm.doc_type)
      WHERE sdm.service_id = ?
      ORDER BY sdm.doc_type ASC
    `, [req.params.id, req.params.serviceId, period, req.params.serviceId]);

    const extraResult = db.exec(`
      SELECT dcs.id AS checklist_id,
             dcs.doc_type,
             dcs.status,
             dcs.received_at,
             dcs.source_message_id,
             dcs.manually_set
      FROM document_checklist_status dcs
      WHERE dcs.client_id  = ?
        AND dcs.service_id = ?
        AND dcs.period     = ?
        AND LOWER(dcs.doc_type) NOT IN (
          SELECT LOWER(doc_type) FROM service_document_map WHERE service_id = ?
        )
      ORDER BY dcs.doc_type ASC
    `, [req.params.id, req.params.serviceId, period, req.params.serviceId]);

    const docs = docsResult.length
      ? docsResult[0].values.map(row => {
          const obj = {};
          docsResult[0].columns.forEach((c, i) => obj[c] = row[i]);
          return obj;
        })
      : [];

    const extras = extraResult.length
      ? extraResult[0].values.map(row => {
          const obj = {};
          extraResult[0].columns.forEach((c, i) => obj[c] = row[i]);
          obj.is_extra = true;
          return obj;
        })
      : [];

    res.json({ docs, extras, period });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/clients/:id/documents/:serviceId
// Upsert a checklist entry — used for manual mark / unmark by the CA.
// Body: { period, doc_type, status ('pending'|'received'), manually_set }
// When manually_set = 1 the AI engine will not overwrite this entry.
app.patch('/api/clients/:id/documents/:serviceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { period, doc_type, status, manually_set } = req.body;
  if (!period || !doc_type) return res.status(400).json({ error: 'period and doc_type required' });
  if (!['pending', 'received'].includes(status)) return res.status(400).json({ error: 'status must be pending or received' });
  try {
    // M12 — conflict detection, same pattern as the subtask status route.
    const CONFLICT_WINDOW_SECONDS = 15;
    try {
      const prevRow = db.exec(`
        SELECT status, updated_at FROM document_checklist_status
        WHERE client_id = ? AND service_id = ? AND period = ? AND doc_type = ?
      `, [req.params.id, req.params.serviceId, period, doc_type]);
      if (prevRow.length && prevRow[0].values.length) {
        const [prevStatus, prevUpdatedAt] = prevRow[0].values[0];
        const secondsSince = prevUpdatedAt ? (new Date() - new Date(prevUpdatedAt)) / 1000 : Infinity;
        if (prevStatus !== status && secondsSince >= 0 && secondsSince < CONFLICT_WINDOW_SECONDS) {
          db.run(`
            INSERT INTO notifications (type, client_id, service_id, period, message, status)
            VALUES ('conflict_detected', ?, ?, ?, ?, 'active')
          `, [req.params.id, req.params.serviceId, period,
              `${doc_type} — set to "${prevStatus}" and "${status}" within seconds of each other. Please confirm.`]);
        }
      }
    } catch (e) { console.error('[Alerts] Conflict check (document) error:', e.message); }

    const now = status === 'received' ? new Date().toISOString() : null;
    db.run(`
      INSERT INTO document_checklist_status
        (client_id, service_id, period, doc_type, status, received_at, manually_set, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(client_id, service_id, period, doc_type) DO UPDATE SET
        status       = excluded.status,
        received_at  = excluded.received_at,
        manually_set = excluded.manually_set,
        updated_at   = CURRENT_TIMESTAMP
    `, [req.params.id, req.params.serviceId, period, doc_type, status, now, manually_set ? 1 : 0]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/clients/:id/documents/:serviceId
// Add a one-off document not in the standard service checklist.
// Body: { period, doc_type }
// Created as manually_set = 1 with status = 'pending' so CA can then mark it received.
app.post('/api/clients/:id/documents/:serviceId', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  const { period, doc_type } = req.body;
  if (!period || !doc_type) return res.status(400).json({ error: 'period and doc_type required' });
  try {
    db.run(`
      INSERT OR IGNORE INTO document_checklist_status
        (client_id, service_id, period, doc_type, status, manually_set)
      VALUES (?, ?, ?, ?, 'pending', 1)
    `, [req.params.id, req.params.serviceId, period, doc_type.trim()]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// COMPLIANCE OVERVIEW — MILESTONE 11.8
// ═════════════════════════════════════════════════════════════════════════════

// _periodDeadline / _periodEndDate / _subtaskDeadline — extracted to
// src/deadlineEngine.js during M12, so this logic is shared with the new
// alert-firing sweep in ai/processor.js instead of living as two
// hand-maintained copies. While extracting, found _periodDeadline still had
// the local-time-then-.toISOString() bug that was fixed in _subtaskDeadline
// back in M11.9 — fixed now in the shared copy (see deadlineEngine.js).
// Aliased back to their original local names so no other line in this file
// needs to change.
const {
  periodEndDate: _periodEndDate,
  subtaskDeadline: _subtaskDeadline,
  periodDeadline: _periodDeadline,
} = require('./src/deadlineEngine');


// Returns the full compliance grid: all clients × their assigned services.
//
// M12 change — each cell is now driven by its ACTIVE SUBTASK, not a
// whole-service aggregate:
//   1. Every subtask matching the current period's frequency gets a real
//      due date via _subtaskDeadline() (due_day + due_month_offset).
//   2. Dated subtasks are sorted chronologically. The "active subtask" is
//      the earliest one not yet Done — its own docs/deadline drive the cell.
//   3. Once a dated subtask's due date passes without being marked Done,
//      focus silently moves to the next dated subtask — but it's kept in
//      `overdue_subtasks` on the cell so it isn't lost (this is what M12
//      Smart Alerts will read to fire "you missed this deadline").
//   4. If every dated subtask is Done/passed and only undated ones remain,
//      the cell falls back to the pre-M12 whole-service aggregate view.
//
// cell_status precedence (within whichever subtask/aggregate is driving it):
//   'all_done'       — every subtask (dated + undated) is Done
//   'deadline_alert' — within alert_days of the driving deadline
//   'docs_missing'   — driving item has expected docs and some are missing
//   'in_progress'    — driving item has started (status or partial docs)
//   'not_started'    — nothing started yet
app.get('/api/compliance/overview', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    // ── Query A: base client × service rows + service-level deadline info ──
    const baseRes = db.exec(`
      SELECT
        c.id           AS client_id,
        c.name         AS client_name,
        c.is_qrmp,
        s.id           AS service_id,
        s.name         AS service_name,
        cs.current_period,
        cs.rule_type_override,
        dr.rule_type,
        dr.due_day     AS svc_due_day,
        dr.due_month   AS svc_due_month,
        dr.alert_days  AS svc_alert_days
      FROM clients c
      JOIN client_services cs     ON cs.client_id = c.id
      JOIN services s             ON s.id          = cs.service_id
      LEFT JOIN deadline_rules dr ON dr.service_id = s.id
      ORDER BY c.name ASC, s.name ASC
    `);

    // ── Query B: subtask definitions for ALL services (one-shot, not N+1) ──
    const stRes = db.exec(`
      SELECT id, service_id, name, sort_order, frequency, due_day, due_month_offset, alert_days
      FROM subtasks
      WHERE client_id IS NULL
    `);

    // ── Query C: client_subtask_status for ALL clients ──
    const cssRes = db.exec(`SELECT client_id, subtask_id, status FROM client_subtask_status`);

    // ── Query D: service_document_map for ALL services (doc → subtask link) ──
    const sdmRes = db.exec(`SELECT id, service_id, doc_type, subtask_id FROM service_document_map`);

    // ── Query E: document_checklist_status for the CURRENT period only ──
    const docRes = db.exec(`
      SELECT dcs.client_id, dcs.service_id, dcs.doc_type, dcs.status
      FROM document_checklist_status dcs
      JOIN client_services cs ON cs.client_id = dcs.client_id AND cs.service_id = dcs.service_id
      WHERE dcs.period = cs.current_period
    `);

    // ── Build fast lookup maps ──────────────────────────────────────────────
    const subtasksByService = {}; // service_id -> [subtask defs]
    if (stRes.length && stRes[0].values.length) {
      const cols = stRes[0].columns;
      stRes[0].values.forEach(row => {
        const r = {}; cols.forEach((c, i) => r[c] = row[i]);
        (subtasksByService[r.service_id] = subtasksByService[r.service_id] || []).push(r);
      });
    }

    const cssMap = {}; // "clientId:subtaskId" -> status
    if (cssRes.length && cssRes[0].values.length) {
      cssRes[0].values.forEach(([cid, stid, status]) => { cssMap[`${cid}:${stid}`] = status; });
    }

    const sdmByService = {}; // service_id -> [{id, doc_type, subtask_id}]
    if (sdmRes.length && sdmRes[0].values.length) {
      sdmRes[0].values.forEach(([id, sid, doc_type, subtask_id]) => {
        (sdmByService[sid] = sdmByService[sid] || []).push({ id, doc_type, subtask_id });
      });
    }

    const docStatusMap = {}; // "clientId:serviceId:doctype_lower" -> 'received' | 'pending'
    if (docRes.length && docRes[0].values.length) {
      docRes[0].values.forEach(([cid, sid, doc_type, status]) => {
        docStatusMap[`${cid}:${sid}:${String(doc_type).toLowerCase()}`] = status;
      });
    }

    // Small shared helper — docs expected/received for a WHOLE service
    // (used by the two fallback branches, same as pre-M12 behaviour).
    function wholeServiceDocs(clientId, serviceId) {
      const docs = sdmByService[serviceId] || [];
      const received = docs.filter(d =>
        docStatusMap[`${clientId}:${serviceId}:${String(d.doc_type).toLowerCase()}`] === 'received'
      ).length;
      return { docsExpected: docs.length, docsReceived: received };
    }

    // ── Merge + compute cell_status ────────────────────────────────────────
    const today      = new Date().toISOString().split('T')[0];
    const serviceSet = new Map();
    const cells      = [];

    if (baseRes.length && baseRes[0].values.length) {
      const cols = baseRes[0].columns;
      baseRes[0].values.forEach(row => {
        const r = {}; cols.forEach((c, i) => r[c] = row[i]);

        if (!serviceSet.has(r.service_id)) {
          serviceSet.set(r.service_id, { id: r.service_id, name: r.service_name });
        }

        // Effective cadence for THIS client+service: a per-client override
        // wins over the service's own default. due_day/due_month are never
        // overridden — those always come from the service's deadline_rules.
        const effectiveRuleType = r.rule_type_override || r.rule_type;

        // Subtasks that apply to THIS period type (frequency filter — the
        // original GSTR-9 fix, unchanged, now measured against the
        // client's effective cadence rather than always the service's own).
        const allSubtasks = (subtasksByService[r.service_id] || []).filter(
          st => !st.frequency || st.frequency === effectiveRuleType
        );

        // Attach live status + a real computed deadline to each subtask.
        const enriched = allSubtasks.map(st => {
          const status = cssMap[`${r.client_id}:${st.id}`] || 'Pending';
          const ruleTypeForThis = st.frequency || effectiveRuleType;
          const deadline = _subtaskDeadline(st, r.current_period, ruleTypeForThis);
          const linkedDocs = (sdmByService[r.service_id] || []).filter(d => d.subtask_id === st.id);
          const docsReceived = linkedDocs.filter(d =>
            docStatusMap[`${r.client_id}:${r.service_id}:${String(d.doc_type).toLowerCase()}`] === 'received'
          ).length;
          return { ...st, status, deadline, docsExpected: linkedDocs.length, docsReceived };
        });

        const subtasksTotal      = enriched.length;
        const subtasksDone       = enriched.filter(s => s.status === 'Done').length;
        const subtasksInProgress = enriched.filter(s => s.status === 'In Progress').length;

        const dated = enriched
          .filter(s => s.deadline)
          .sort((a, b) => a.deadline === b.deadline ? a.sort_order - b.sort_order : (a.deadline < b.deadline ? -1 : 1));
        const undated = enriched.filter(s => !s.deadline);

        // Dated subtasks whose date has passed without being marked Done.
        // Kept on the cell regardless of branch — this is what M12 Smart
        // Alerts will read to fire "you missed this deadline" notifications.
        const overdueSubtasks = dated
          .filter(s => s.deadline < today && s.status !== 'Done')
          .map(s => ({
            id: s.id, name: s.name, deadline: s.deadline,
            days_overdue: Math.floor((new Date(today) - new Date(s.deadline)) / 86400000),
          }));

        // "Active" = earliest dated subtask that is BOTH not yet Done AND
        // not yet past its own due date. A subtask whose date has already
        // passed while undone does NOT become/stay active — it drops into
        // overdueSubtasks above instead, and focus moves to the next one.
        // This is what makes GSTR-1 (missed) hand off to GSTR-2B
        // Reconciliation automatically, per the agreed behaviour.
        const activeSubtask = dated.find(s => s.status !== 'Done' && s.deadline >= today);

        let cell_status, deadline, daysUntilDeadline, alertDays, docsExpected, docsReceived;
        let activeSubtaskId = null, activeSubtaskName = null;

        if (activeSubtask) {
          // ── Branch 1: an active, dated subtask drives the cell ──────────
          activeSubtaskId   = activeSubtask.id;
          activeSubtaskName = activeSubtask.name;
          deadline          = activeSubtask.deadline;
          alertDays         = (activeSubtask.alert_days != null) ? activeSubtask.alert_days : (r.svc_alert_days || 3);
          daysUntilDeadline = Math.ceil((new Date(deadline) - new Date(today)) / (1000 * 60 * 60 * 24));
          const isDeadlineAlert = daysUntilDeadline >= 0 && daysUntilDeadline <= alertDays;
          docsExpected = activeSubtask.docsExpected;
          docsReceived = activeSubtask.docsReceived;

          if (isDeadlineAlert) cell_status = 'deadline_alert';
          else if (docsExpected > 0 && docsReceived < docsExpected) cell_status = 'docs_missing';
          else if (activeSubtask.status === 'In Progress' || docsReceived > 0) cell_status = 'in_progress';
          else cell_status = 'not_started';

        } else if (subtasksTotal > 0 && subtasksDone >= subtasksTotal) {
          // ── Branch 2: every subtask (dated + undated) is Done ───────────
          cell_status = 'all_done';
          const rule = { rule_type: effectiveRuleType, due_day: r.svc_due_day, due_month: r.svc_due_month };
          deadline          = _periodDeadline(rule, r.current_period);
          alertDays         = r.svc_alert_days || 3;
          daysUntilDeadline = deadline ? Math.ceil((new Date(deadline) - new Date(today)) / (1000 * 60 * 60 * 24)) : null;
          ({ docsExpected, docsReceived } = wholeServiceDocs(r.client_id, r.service_id));

        } else {
          // ── Branch 3: fallback — only undated subtasks remain (or none
          // defined at all). No single subtask to focus on, so behave
          // exactly like the pre-M12 whole-service aggregate logic. ───────
          const rule = { rule_type: effectiveRuleType, due_day: r.svc_due_day, due_month: r.svc_due_month };
          deadline          = _periodDeadline(rule, r.current_period);
          alertDays         = r.svc_alert_days || 3;
          daysUntilDeadline = deadline ? Math.ceil((new Date(deadline) - new Date(today)) / (1000 * 60 * 60 * 24)) : null;
          const isDeadlineAlert = daysUntilDeadline != null && daysUntilDeadline >= 0 && daysUntilDeadline <= alertDays;
          ({ docsExpected, docsReceived } = wholeServiceDocs(r.client_id, r.service_id));

          if (isDeadlineAlert) cell_status = 'deadline_alert';
          else if (docsExpected > 0 && docsReceived < docsExpected) cell_status = 'docs_missing';
          else if (subtasksDone > 0 || subtasksInProgress > 0) cell_status = 'in_progress';
          else cell_status = 'not_started';
        }

        cells.push({
          client_id:            r.client_id,
          client_name:          r.client_name,
          is_qrmp:              r.is_qrmp || 0,
          service_id:           r.service_id,
          service_name:         r.service_name,
          current_period:       r.current_period,
          rule_type_override:   r.rule_type_override || null,
          effective_rule_type:  effectiveRuleType || null,
          deadline,
          days_until_deadline:  daysUntilDeadline,
          alert_days:           alertDays,
          subtasks_total:       subtasksTotal,
          subtasks_done:        subtasksDone,
          subtasks_in_progress: subtasksInProgress,
          docs_expected:        docsExpected,
          docs_received:        docsReceived,
          active_subtask_id:    activeSubtaskId,
          active_subtask_name:  activeSubtaskName,
          overdue_subtasks:     overdueSubtasks,
          cell_status,
        });
      });
    }

    res.json({
      services: [...serviceSet.values()],
      cells,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS — MILESTONE 12 (Smart Alerts & Notification Bell)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/notifications — active notifications for the bell dropdown.
// Newest first. Joins client/service/subtask names so the dashboard doesn't
// need follow-up calls to render a readable list.
app.get('/api/notifications', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT
        n.id, n.type, n.client_id, c.name AS client_name,
        n.service_id, s.name AS service_name,
        n.subtask_id, st.name AS subtask_name,
        n.period, n.message, n.status, n.created_at
      FROM notifications n
      LEFT JOIN clients  c  ON c.id = n.client_id
      LEFT JOIN services s  ON s.id = n.service_id
      LEFT JOIN subtasks st ON st.id = n.subtask_id
      WHERE n.status = 'active'
      ORDER BY n.created_at DESC
    `);
    const notifications = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((col, i) => obj[col] = row[i]);
          return obj;
        })
      : [];
    res.json({ notifications, count: notifications.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/:id/dismiss — CA closes a notification manually.
// Stays hidden unless the underlying condition clears and later re-triggers
// as a fresh instance (new period, new overdue subtask, etc.) — see
// _fireOrResolve in ai/processor.js for the matching logic on the firing side.
app.patch('/api/notifications/:id/dismiss', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    db.run(`
      UPDATE notifications SET status = 'dismissed', dismissed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [req.params.id]);
    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// CONVERSATIONS — MILESTONE 11.5
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/conversations — all open conversation threads for the inbox
// Returns one record per open thread, with client name and message count.
// Dashboard uses this to render thread cards for linked senders in Layer 1.
app.get('/api/conversations', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT
        cv.id,
        cv.client_id,
        c.name        AS client_name,
        cv.service_tag,
        cv.status,
        cv.running_summary,
        cv.message_count,
        cv.created_at,
        cv.last_message_at,
        cv.resolved_at,
        cv.resolved_reason
      FROM conversations cv
      JOIN clients c ON c.id = cv.client_id
      WHERE cv.status = 'open'
      ORDER BY cv.last_message_at DESC
    `);

    const conversations = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((col, i) => obj[col] = row[i]);
          return obj;
        })
      : [];

    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conversations/:id/messages — all messages inside a thread
// Used when the CA expands a thread card in Layer 1 to see individual messages.
app.get('/api/conversations/:id/messages', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const result = db.exec(`
      SELECT
        m.id,
        m.source,
        m.sender_name,
        m.sender_email,
        m.sender_phone,
        m.subject,
        m.category,
        m.urgency,
        m.ai_summary,
        m.attachment_count,
        m.received_at,
        m.direction
      FROM messages m
      WHERE m.conversation_id = ?
        AND (m.direction = 'incoming' OR m.direction IS NULL)
      ORDER BY m.received_at ASC
    `, [req.params.id]);

    const messages = result.length
      ? result[0].values.map(row => {
          const obj = {};
          result[0].columns.forEach((col, i) => obj[col] = row[i]);
          return obj;
        })
      : [];

    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conversations/:id/resolve — manually resolve a thread
// CA can use this as an override — closes the thread immediately and
// writes a timeline entry exactly as the auto-resolution does.
app.post('/api/conversations/:id/resolve', (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ error: 'Database not ready' });
  try {
    const convRow = db.exec(`
      SELECT client_id, service_tag, running_summary
      FROM conversations WHERE id = ?
    `, [req.params.id]);

    if (!convRow.length || !convRow[0].values.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const [clientId, serviceTag, runningSummary] = convRow[0].values[0];
    const now = new Date().toISOString();

    // Close the thread
    db.run(`
      UPDATE conversations
      SET status = 'resolved', resolved_at = ?, resolved_reason = 'manual'
      WHERE id = ?
    `, [now, req.params.id]);

    // Timeline entry — same format as auto-resolution
    const content = `Conversation marked resolved by CA${runningSummary ? ': ' + runningSummary : ''}`;
    db.run(`
      INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
      VALUES (?, 'system', ?, ?, ?, ?)
    `, [clientId, content, now, serviceTag || null, now]);

    saveDatabase();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// OLLAMA PROXY  (avoids CORS when browser fetches Ollama directly)
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/ollama/models', async (req, res) => {
  try {
    const r = await fetch('http://localhost:11434/api/tags');
    if (!r.ok) throw new Error('Ollama returned ' + r.status);
    const data = await r.json();
    res.json({ models: data.models || [] });
  } catch (e) {
    res.status(503).json({ error: 'Ollama not reachable', models: [] });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// AI PROCESSING — MILESTONE 4
// ═════════════════════════════════════════════════════════════════════════════

const ai = require('./ai/processor');
app.get('/api/ai/status', (req, res) => res.json(ai.getStatus()));

// ═════════════════════════════════════════════════════════════════════════════
// BOOT
// ═════════════════════════════════════════════════════════════════════════════

// Returns this computer's local network IPv4 address(es) — e.g. 192.168.1.42 —
// so other computers on the same office wifi/network can reach the dashboard.
function getLanAddresses() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  }
  return found;
}

async function start() {
  // Check the license before anything else. This never stops the server
  // from starting — it only decides whether AI processing is allowed to
  // run. Existing data stays fully viewable either way (see the route
  // guards throughout this file — none of them check license status).
  const licenseStatus = license.checkLicense(LICENSE_PATH, LICENSE_CONTACT);
  if (licenseStatus.restricted) {
    console.warn(`\n⚠️  LICENSE: ${licenseStatus.message}\n`);
  } else if (licenseStatus.reason === 'expiring_soon') {
    console.log(`\nℹ️  LICENSE: ${licenseStatus.message}\n`);
  }
  // Re-check periodically while running, so dropping in a renewed
  // license.json takes effect without needing a restart.
  setInterval(() => license.checkLicense(LICENSE_PATH, LICENSE_CONTACT), 60 * 60 * 1000);

  // Stage 2 — optional remote early-revoke check. Silently does nothing
  // if firebase_url isn't configured yet. A failed check never restricts
  // anything by itself — see src/licenseRemote.js for why.
  if (LICENSE_FIREBASE_URL) {
    setTimeout(() => { license.refreshRemoteStatus(LICENSE_FIREBASE_URL).catch(() => {}); }, 15000);
    setInterval(() => { license.refreshRemoteStatus(LICENSE_FIREBASE_URL).catch(() => {}); }, LICENSE_REMOTE_HOURS * 60 * 60 * 1000);
  } else {
    console.log('ℹ️  LICENSE: remote check not configured (firebase_url is blank) — using local license only.\n');
  }

  await initDatabase();
  gmail.startPolling(REDIRECT_URI);
  startWhatsAppPolling();
  // Run AI processor immediately on start, then every 30 seconds —
  // but only while the license is in good standing. When restricted,
  // this loop pauses: no new messages get AI-processed, no new alerts
  // fire. Nothing already in the database is touched or hidden.
  const runAiIfLicensed = () => {
    if (!license.isRestricted()) {
      ai.processMessages();
    }
  };
  setTimeout(runAiIfLicensed, 5000);
  setInterval(runAiIfLicensed, 30 * 1000);

  // network.enabled (config.json) controls whether other computers on the
  // office network can reach this server. 0.0.0.0 = accept connections from
  // any device on the network; 127.0.0.1 = this computer only.
  const host = NETWORK_ENABLED ? '0.0.0.0' : '127.0.0.1';

  app.listen(PORT, host, () => {
    console.log(`\n✅  SW.CA1 is running`);
    console.log(`   On this computer      → http://localhost:${PORT}`);

    if (NETWORK_ENABLED) {
      const addresses = getLanAddresses();
      if (addresses.length > 0) {
        addresses.forEach(addr => {
          console.log(`   On other computers    → http://${addr}:${PORT}`);
        });
      } else {
        console.log(`   ⚠️  Network sharing is ON but no network connection was found.`);
        console.log(`      Connect this computer to the office wifi/network and restart.`);
      }
    } else {
      console.log(`   Network sharing is OFF (config.json) — only this computer can view the dashboard.`);
    }

    console.log(`   Press Ctrl+C to stop\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
