// intake/whatsapp.js
// SW.CA1 — WhatsApp Integration (M5)
// Handles QR-based auth, session persistence, and message storage
// Updated M11.5 — captures outgoing CA replies for conversation context

const { Client, LocalAuth } = require('whatsapp-web.js');
const path                  = require('path');
const fs                    = require('fs');
const { getDb, saveDatabase } = require('../src/database');

const SESSIONS_DIR     = path.join(__dirname, '..', 'credentials', 'whatsapp_sessions');
const SESSION_MAP_FILE = path.join(SESSIONS_DIR, 'session_map.json');

// ── In-memory state ───────────────────────────────────────────────────────────
const activeClients = {};     // number -> Client instance
let   pendingClient = null;   // Client mid-QR-scan (number not yet known)
let   pendingQR     = null;   // raw QR string to send to frontend
let   pendingStatus = 'idle'; // 'idle' | 'initializing' | 'qr_ready' | 'connected' | 'failed'
let   pendingNumber = null;   // set once scan succeeds


// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function loadSessionMap() {
  ensureDir();
  if (!fs.existsSync(SESSION_MAP_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf8')); }
  catch { return {}; }
}

function saveSessionMap(map) {
  ensureDir();
  fs.writeFileSync(SESSION_MAP_FILE, JSON.stringify(map, null, 2));
}

function addToSessionMap(number, sessionId) {
  const map = loadSessionMap();
  map[number] = sessionId;
  saveSessionMap(map);
}

function removeFromSessionMap(number) {
  const map = loadSessionMap();
  delete map[number];
  saveSessionMap(map);
}

// Returns array of connected phone numbers
function listConnectedNumbers() {
  return Object.keys(loadSessionMap());
}


// ── Client factory ────────────────────────────────────────────────────────────

function buildClient(sessionId) {
  ensureDir();
  return new Client({
    authStrategy: new LocalAuth({
      clientId: sessionId,
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: {
  headless: true,
  executablePath: 'C:\\Users\\gaura\\.cache\\puppeteer\\chrome\\win64-149.0.7827.54\\chrome-win64\\chrome.exe',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
},
  });
}


// ── Incoming message storage ──────────────────────────────────────────────────
// Messages from clients — buffered for 10 seconds, then stored as one DB entry.
// Stored with direction = 'incoming', processed = 0 (AI will process these).

const messageBuffers = {}; // senderPhone -> { messages: [], timer }

function attachMessageListener(client, accountNumber) {
  // ── Incoming messages (from clients) ────────────────────────────────────────
  client.on('message', async (msg) => {
    if (msg.fromMe) return;                          // skip — handled by message_create
    if (msg.from.endsWith('@g.us')) return;          // skip group chats
    if (msg.from.endsWith('@broadcast')) return;     // skip broadcast lists

    const senderPhone = msg.from.replace('@c.us', '').replace('@g.us', '');

    // Buffer — combine messages from the same sender within 10 seconds into one DB entry
    if (!messageBuffers[senderPhone]) {
      messageBuffers[senderPhone] = { messages: [], timer: null };
    }
    messageBuffers[senderPhone].messages.push(msg);

    if (messageBuffers[senderPhone].timer) {
      clearTimeout(messageBuffers[senderPhone].timer);
    }
    messageBuffers[senderPhone].timer = setTimeout(async () => {
      const buffered = messageBuffers[senderPhone].messages;
      delete messageBuffers[senderPhone];
      await storeBufferedMessages(buffered, accountNumber);
    }, 10000);
  });

  // ── Outgoing messages (CA replies) ──────────────────────────────────────────
  // message_create fires for every message sent from this WhatsApp number,
  // including the CA's own replies. These are stored as context for the AI
  // so it can understand the full conversation and judge resolution.
  //
  // Important rules for outgoing messages:
  //   - direction = 'outgoing'
  //   - processed = 1  → AI processor skips them entirely (no classification needed)
  //   - NOT shown in the inbox (Layer 1 filters by direction = 'incoming')
  //   - NOT buffered — stored immediately, one message per DB row
  //   - Only stored if the recipient is a known linked client (checked via client_sources)
  //     This avoids storing every outgoing message to everyone — only relevant ones
  client.on('message_create', async (msg) => {
    if (!msg.fromMe) return;                         // only CA's own sent messages
    if (msg.to.endsWith('@g.us')) return;            // skip group chats
    if (msg.to.endsWith('@broadcast')) return;       // skip broadcasts

    const recipientPhone = msg.to.replace('@c.us', '').replace('@g.us', '');
    const db = getDb();
    if (!db) return;

    try {
      // Only store if this recipient is linked to a client profile
      // No point capturing outgoing messages to random contacts
      const linked = db.exec(
        `SELECT id FROM client_sources WHERE type = 'whatsapp' AND value = ?`,
        [recipientPhone]
      );
      if (!linked.length || !linked[0].values.length) return;

      // Deduplicate by raw_id
      const rawId = msg.id._serialized;
      const exists = db.exec(`SELECT id FROM messages WHERE raw_id = ?`, [rawId]);
      if (exists.length && exists[0].values.length) return;

      const body      = msg.body || '';
      const sentAt    = new Date(msg.timestamp * 1000).toISOString();

      db.run(`
        INSERT INTO messages
          (source, account, sender_name, sender_phone, body,
           attachment_count, raw_id, received_at, direction, processed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outgoing', 1)
      `, [
        'whatsapp',
        accountNumber,
        'CA',                          // sender is the CA themselves
        recipientPhone,                // store recipient phone so JOIN on client_sources works
        body.slice(0, 5000),
        msg.hasMedia ? 1 : 0,
        rawId,
        sentAt,
      ]);

      saveDatabase();
      console.log(`[WhatsApp] Stored outgoing reply to ${recipientPhone}`);

    } catch (err) {
      console.error('[WhatsApp] Error storing outgoing message:', err.message);
    }
  });
}

// ── Store a batch of buffered incoming messages ───────────────────────────────
async function storeBufferedMessages(messages, accountNumber) {
  const db = getDb();
  if (!db) return;

  try {
    const firstMsg    = messages[0];
    const contact     = await firstMsg.getContact();
    const senderName  = contact.pushname || contact.name || firstMsg.from;
    const senderPhone = firstMsg.from.replace('@c.us', '').replace('@g.us', '');

    // Combine all message bodies into one entry
    const combinedBody    = messages.map(m => m.body || '').filter(Boolean).join(' ');
    const attachmentCount = messages.filter(m => m.hasMedia).length;
    const receivedAt      = new Date(firstMsg.timestamp * 1000).toISOString();
    const rawId           = firstMsg.id._serialized;

    // Deduplicate
    const exists = db.exec(`SELECT id FROM messages WHERE raw_id = ?`, [rawId]);
    if (exists.length && exists[0].values.length) return;

    db.run(`
      INSERT INTO messages
        (source, account, sender_name, sender_phone, body,
         attachment_count, raw_id, received_at, direction, processed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'incoming', 0)
    `, [
      'whatsapp',
      accountNumber,
      senderName,
      senderPhone,
      combinedBody.slice(0, 5000),
      attachmentCount,
      rawId,
      receivedAt,
    ]);

    // Store attachment metadata
    const msgRow = db.exec(`SELECT id FROM messages WHERE raw_id = ?`, [rawId]);
    if (msgRow.length && msgRow[0].values.length) {
      const msgDbId = msgRow[0].values[0][0];
      for (const m of messages) {
        if (!m.hasMedia) continue;
        const filename = m.filename || `whatsapp_attachment_${m.type || 'file'}`;
        db.run(
          `INSERT INTO attachments (message_id, filename, mime_type) VALUES (?, ?, ?)`,
          [msgDbId, filename, m.type || 'application/octet-stream']
        );
      }
    }

    saveDatabase();
    console.log(`[WhatsApp] Stored incoming message from ${senderPhone} (${messages.length} segment(s))`);

  } catch (err) {
    console.error('[WhatsApp] Error storing buffered message:', err.message);
  }
}

// ── Backlog sweep — runs on ready, before live listener attaches ──────────────
// Fetches unread messages from all chats that arrived while the server was off.
// Only sweeps incoming messages — outgoing replies sent while offline are not
// captured (WhatsApp web does not expose sent message history on reconnect).

async function sweepBacklog(client, accountNumber) {
  try {
    const chats = await client.getChats();
    let sweptCount = 0;

    for (const chat of chats) {
      if (chat.isGroup) continue;
      if (chat.unreadCount <= 0) continue;

      const messages = await chat.fetchMessages({ limit: chat.unreadCount });
      const incoming = messages.filter(m => !m.fromMe);
      if (incoming.length === 0) continue;

      await storeBufferedMessages(incoming, accountNumber);
      sweptCount += incoming.length;
    }

    if (sweptCount > 0) {
      console.log(`[WhatsApp] ✅ Backlog: stored ${sweptCount} missed message(s) for ${accountNumber}`);
    } else {
      console.log(`[WhatsApp] Backlog sweep: nothing missed for ${accountNumber}`);
    }
  } catch (err) {
    console.error(`[WhatsApp] Backlog sweep error for ${accountNumber}:`, err.message);
  }
}


// ── Start a new WhatsApp connection (triggers QR generation) ──────────────────

function startNewConnection() {
  if (pendingClient) {
    return { status: pendingStatus, qr: pendingQR };
  }

  pendingStatus = 'initializing';
  pendingQR     = null;
  pendingNumber = null;

  const sessionId = `wa_${Date.now()}`;
  pendingClient   = buildClient(sessionId);

  pendingClient.on('qr', (qr) => {
    pendingQR     = qr;
    pendingStatus = 'qr_ready';
    console.log('[WhatsApp] QR ready — waiting for phone scan');
  });

  pendingClient.on('ready', async () => {
    const number = pendingClient.info.wid.user;
    console.log(`[WhatsApp] Account connected: ${number}`);

    pendingStatus = 'connected';
    pendingNumber = number;

    addToSessionMap(number, sessionId);
    activeClients[number] = pendingClient;

    // Attach both incoming and outgoing listeners
    attachMessageListener(pendingClient, number);

    setTimeout(() => {
      pendingClient = null;
      pendingQR     = null;
      pendingStatus = 'idle';
      pendingNumber = null;
    }, 8000);
  });

  pendingClient.on('auth_failure', (msg) => {
    console.error('[WhatsApp] Auth failure:', msg);
    pendingStatus = 'failed';
    pendingClient = null;
    pendingQR     = null;
  });

  pendingClient.on('disconnected', (reason) => {
    console.warn('[WhatsApp] Pending client disconnected:', reason);
    pendingStatus = 'idle';
    pendingClient = null;
    pendingQR     = null;
  });

  pendingClient.initialize();
  return { status: pendingStatus };
}

// Frontend polls this to get QR and know when connection is done
function getConnectionStatus() {
  return {
    status: pendingStatus,
    qr:     pendingQR,
    number: pendingNumber,
  };
}

// Cancel a pending connection attempt
function cancelPendingConnection() {
  if (pendingClient) {
    try { pendingClient.destroy(); } catch {}
    pendingClient = null;
  }
  pendingQR     = null;
  pendingNumber = null;
  pendingStatus = 'idle';
}


// ── Disconnect a number ───────────────────────────────────────────────────────

async function disconnectNumber(number) {
  const client = activeClients[number];
  if (client) {
    try { await client.destroy(); } catch {}
    delete activeClients[number];
  }

  const map       = loadSessionMap();
  const sessionId = map[number];
  if (sessionId) {
    const sessionPath = path.join(SESSIONS_DIR, `session-${sessionId}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  removeFromSessionMap(number);
  console.log(`[WhatsApp] Disconnected ${number}`);
  return true;
}


// ── Boot — restore all previously connected accounts ─────────────────────────

async function startPolling() {
  const map     = loadSessionMap();
  const numbers = Object.keys(map);

  if (numbers.length === 0) {
    console.log('[WhatsApp] No connected accounts — skipping startup');
    return;
  }

  console.log(`[WhatsApp] Restoring ${numbers.length} account(s)...`);

  // Sanity-check the hardcoded Chrome path up front — if it's missing,
  // every restore will fail silently inside Puppeteer otherwise.
  const chromePath = 'C:\\Users\\gaura\\.cache\\puppeteer\\chrome\\win64-149.0.7827.54\\chrome-win64\\chrome.exe';
  if (!fs.existsSync(chromePath)) {
    console.error(`[WhatsApp] ❌ Chrome executable not found at: ${chromePath}`);
    console.error('[WhatsApp]    Check if it was moved, removed, or auto-updated to a new folder.');
  }

  for (const number of numbers) {
    const sessionId = map[number];
    const client    = buildClient(sessionId);

    // Watchdog — if 'ready' hasn't fired within 60s, something is stuck
    // (Puppeteer launch, page load, or session corruption) with no other signal.
    let readyFired = false;
    const watchdog = setTimeout(() => {
      if (!readyFired) {
        console.error(`[WhatsApp] ⏱️ Restore for ${number} has not become ready after 60s — likely stuck (check Chrome path, network, or session corruption).`);
      }
    }, 60000);

    client.on('loading_screen', (percent, message) => {
      console.log(`[WhatsApp] Loading ${number}: ${percent}% — ${message}`);
    });

    client.on('ready', async () => {
      readyFired = true;
      clearTimeout(watchdog);
      console.log(`[WhatsApp] Restored session for ${number}`);
      activeClients[number] = client;
      await sweepBacklog(client, number);
      attachMessageListener(client, number);
    });

    client.on('auth_failure', (msg) => {
      readyFired = true;
      clearTimeout(watchdog);
      console.error(`[WhatsApp] Session expired for ${number} — needs re-scan. Reason: ${msg}`);
      removeFromSessionMap(number);
    });

    client.on('disconnected', (reason) => {
      readyFired = true;
      clearTimeout(watchdog);
      console.warn(`[WhatsApp] ${number} disconnected: ${reason}`);
      delete activeClients[number];
    });

    // This was the main gap: initialize() returns a Promise and can reject
    // (Puppeteer launch failure, corrupted session, page load error, etc.)
    // Previously that rejection was never caught — it failed completely silently.
    client.initialize().catch((err) => {
      readyFired = true;
      clearTimeout(watchdog);
      console.error(`[WhatsApp] ❌ Failed to initialize session for ${number}:`, err && err.message ? err.message : err);
      console.error(err && err.stack ? err.stack : '');
    });
  }
}


// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  startPolling,
  startNewConnection,
  getConnectionStatus,
  cancelPendingConnection,
  listConnectedNumbers,
  disconnectNumber,
};
