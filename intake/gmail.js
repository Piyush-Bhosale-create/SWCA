// intake/gmail.js
// SW.CA1 — Gmail Integration
// Handles OAuth2 flow, token storage, and email polling (every 2 minutes)
// Updated M11.5 — also polls SENT label to capture CA's outgoing replies

const { google }  = require('googleapis');
const path        = require('path');
const fs          = require('fs');
const { getDb, saveDatabase } = require('../src/database');

const CREDENTIALS_DIR  = path.join(__dirname, '..', 'credentials');
const OAUTH_FILE       = path.join(CREDENTIALS_DIR, 'gmail_oauth.json');
const SCOPES           = ['https://www.googleapis.com/auth/gmail.readonly'];
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

// ── Ensure credentials folder exists ─────────────────────────────────────────
function ensureCredentialsDir() {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
}

// ── Load saved OAuth credentials (Client ID + Secret) ────────────────────────
function loadOAuthCredentials() {
  if (!fs.existsSync(OAUTH_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(OAUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ── Save OAuth credentials entered through Settings UI ───────────────────────
function saveOAuthCredentials(clientId, clientSecret) {
  ensureCredentialsDir();
  fs.writeFileSync(OAUTH_FILE, JSON.stringify({ clientId, clientSecret }, null, 2));
}

// ── Build an OAuth2 client from saved credentials ────────────────────────────
function buildOAuthClient(redirectUri) {
  const creds = loadOAuthCredentials();
  if (!creds) throw new Error('Gmail credentials not saved yet. Enter them in Settings first.');
  return new google.auth.OAuth2(creds.clientId, creds.clientSecret, redirectUri);
}

// ── Generate the Google login URL ─────────────────────────────────────────────
function getAuthUrl(redirectUri) {
  const oauth2Client = buildOAuthClient(redirectUri);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

// ── Exchange code for tokens and save ─────────────────────────────────────────
async function handleCallback(code, redirectUri) {
  const oauth2Client = buildOAuthClient(redirectUri);
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const gmail   = google.gmail({ version: 'v1', auth: oauth2Client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const email   = profile.data.emailAddress;

  ensureCredentialsDir();
  const tokenFile = path.join(CREDENTIALS_DIR, `gmail_${email}.json`);
  fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2));

  console.log(`[Gmail] Connected account: ${email}`);
  return email;
}

// ── List all connected Gmail accounts ─────────────────────────────────────────
function listConnectedAccounts() {
  ensureCredentialsDir();
  const files = fs.readdirSync(CREDENTIALS_DIR);
  return files
    .filter(f => f.startsWith('gmail_') && f.endsWith('.json') && f !== 'gmail_oauth.json')
    .map(f => f.replace('gmail_', '').replace('.json', ''));
}

// ── Disconnect (remove token file) ────────────────────────────────────────────
function disconnectAccount(email) {
  const tokenFile = path.join(CREDENTIALS_DIR, `gmail_${email}.json`);
  if (fs.existsSync(tokenFile)) {
    fs.unlinkSync(tokenFile);
    console.log(`[Gmail] Disconnected account: ${email}`);
    return true;
  }
  return false;
}

// ── Build authenticated Gmail client for a saved account ─────────────────────
function buildGmailClientForAccount(email, redirectUri) {
  const tokenFile = path.join(CREDENTIALS_DIR, `gmail_${email}.json`);
  if (!fs.existsSync(tokenFile)) throw new Error(`No token found for ${email}`);

  const tokens       = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  const oauth2Client = buildOAuthClient(redirectUri);
  oauth2Client.setCredentials(tokens);

  // Auto-save refreshed tokens
  oauth2Client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    fs.writeFileSync(tokenFile, JSON.stringify(merged, null, 2));
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── Helper: extract plain text body from Gmail message payload ────────────────
function extractBody(payload) {
  let body = '';
  const parts = payload.parts || [];

  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  const findText = (payloadParts) => {
    for (const part of payloadParts || []) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        body = Buffer.from(part.body.data, 'base64').toString('utf8');
        return;
      }
      if (part.parts) findText(part.parts);
    }
  };
  findText(parts);
  return body;
}

// ── Helper: parse date string safely ─────────────────────────────────────────
function parseDate(dateStr) {
  try { return new Date(dateStr).toISOString(); }
  catch { return new Date().toISOString(); }
}

// ── Fetch new INBOX emails for one account ────────────────────────────────────
// Unchanged from M5 — incoming messages from clients.
// Now explicitly stores direction = 'incoming'.
async function fetchInboxEmails(gmail, accountEmail, db) {
  try {
    const listRes  = await gmail.users.messages.list({
      userId:     'me',
      labelIds:   ['INBOX'],
      maxResults: 20,
    });
    const messages = listRes.data.messages || [];

    for (const msg of messages) {
      // Skip if already stored
      const exists = db.exec(`SELECT id FROM messages WHERE raw_id = ?`, [msg.id]);
      if (exists.length && exists[0].values.length) continue;

      const full    = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers || [];
      const getH    = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

      const subject    = getH('Subject');
      const fromRaw    = getH('From');
      const dateStr    = getH('Date');
      const fromMatch  = fromRaw.match(/^(.*?)\s*<(.+?)>$/);
      const senderName  = fromMatch ? fromMatch[1].replace(/"/g, '').trim() : fromRaw;
      const senderEmail = fromMatch ? fromMatch[2] : fromRaw;
      const receivedAt  = parseDate(dateStr);

      const parts       = full.data.payload.parts || [];
      const attachments = parts.filter(p => p.filename && p.filename.length > 0);
      const body        = extractBody(full.data.payload);

      db.run(
        `INSERT INTO messages
           (source, account, sender_name, sender_email, subject, body,
            attachment_count, raw_id, received_at, direction, processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'incoming', 0)`,
        [
          'gmail', accountEmail, senderName, senderEmail, subject,
          body.slice(0, 5000), attachments.length, msg.id, receivedAt,
        ]
      );

      // Attachment metadata
      const modeRow        = db.exec(`SELECT value FROM settings WHERE key = 'attachment_mode'`);
      const attachmentMode = (modeRow.length && modeRow[0].values.length) ? modeRow[0].values[0][0] : 'metadata';
      const msgRow         = db.exec(`SELECT id FROM messages WHERE raw_id = ?`, [msg.id]);

      if (msgRow.length && msgRow[0].values.length) {
        const msgDbId = msgRow[0].values[0][0];
        for (const att of attachments) {
          db.run(
            `INSERT INTO attachments (message_id, filename, mime_type, gmail_part_id) VALUES (?, ?, ?, ?)`,
            [msgDbId, att.filename, att.mimeType, att.partId || '']
          );

          if (attachmentMode === 'download' && att.body && att.body.attachmentId) {
            try {
              const attData = await gmail.users.messages.attachments.get({
                userId: 'me', messageId: msg.id, id: att.body.attachmentId,
              });
              if (attData.data && attData.data.data) {
                const fileBytes = Buffer.from(attData.data.data, 'base64');
                const saveDir   = path.join(__dirname, '..', 'data', 'attachments', msg.id);
                if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
                const safeName  = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
                const localPath = path.join(saveDir, safeName);
                fs.writeFileSync(localPath, fileBytes);
                db.run(
                  `UPDATE attachments SET local_path = ? WHERE message_id = ? AND filename = ?`,
                  [localPath, msgDbId, att.filename]
                );
                console.log(`[Gmail] Downloaded attachment: ${att.filename}`);
              }
            } catch (dlErr) {
              console.error(`[Gmail] Failed to download attachment ${att.filename}:`, dlErr.message);
            }
          }
        }
      }
    }

    console.log(`[Gmail] Inbox polled for ${accountEmail} — ${messages.length} message(s) checked`);

  } catch (err) {
    console.error(`[Gmail] Error polling inbox for ${accountEmail}:`, err.message);
  }
}

// ── Fetch recently sent emails for one account (M11.5) ───────────────────────
// Polls the SENT label to capture the CA's own outgoing replies.
// These are stored as context for the AI — never shown in the inbox.
//
// Rules:
//   direction  = 'outgoing'
//   processed  = 1  → AI loop skips them entirely
//   sender_email stores the RECIPIENT (the To: address) so the JOIN on
//   client_sources works correctly — we need to match who this was sent TO,
//   not who sent it (which is always the CA themselves)
//   Only stored if the recipient is a linked client in client_sources
async function fetchSentEmails(gmail, accountEmail, db) {
  try {
    const listRes  = await gmail.users.messages.list({
      userId:     'me',
      labelIds:   ['SENT'],
      maxResults: 20,
    });
    const messages = listRes.data.messages || [];

    for (const msg of messages) {
      // Skip if already stored
      const exists = db.exec(`SELECT id FROM messages WHERE raw_id = ?`, [msg.id]);
      if (exists.length && exists[0].values.length) continue;

      const full    = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
      const headers = full.data.payload.headers || [];
      const getH    = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

      const toRaw   = getH('To');
      const dateStr = getH('Date');
      const subject = getH('Subject');

      // Parse recipient address from "Name <email>" format
      const toMatch      = toRaw.match(/^(.*?)\s*<(.+?)>$/);
      const recipientEmail = toMatch ? toMatch[2].trim() : toRaw.trim();

      if (!recipientEmail) continue;

      // Only store if recipient is a linked client — same logic as WhatsApp outgoing
      const linked = db.exec(
        `SELECT id FROM client_sources WHERE type = 'email' AND LOWER(value) = LOWER(?)`,
        [recipientEmail]
      );
      if (!linked.length || !linked[0].values.length) continue;

      const sentAt = parseDate(dateStr);
      const body   = extractBody(full.data.payload);

      // Store with sender_email = recipient address so JOIN on client_sources works.
      // sender_name = 'CA' makes it clear in any debugging who sent this.
      db.run(
        `INSERT INTO messages
           (source, account, sender_name, sender_email, subject, body,
            attachment_count, raw_id, received_at, direction, processed)
         VALUES (?, ?, 'CA', ?, ?, ?, 0, ?, ?, 'outgoing', 1)`,
        [
          'gmail', accountEmail, recipientEmail, subject,
          body.slice(0, 5000), msg.id, sentAt,
        ]
      );

      console.log(`[Gmail] Stored outgoing reply to ${recipientEmail}`);
    }

  } catch (err) {
    console.error(`[Gmail] Error polling sent for ${accountEmail}:`, err.message);
  }
}

// ── Fetch new emails for one account — inbox + sent ───────────────────────────
async function fetchNewEmails(email, redirectUri) {
  const db = getDb();
  if (!db) return;

  let gmail;
  try {
    gmail = buildGmailClientForAccount(email, redirectUri);
  } catch (err) {
    console.error(`[Gmail] Cannot build client for ${email}:`, err.message);
    return;
  }

  // Run inbox and sent polling one after the other for this account
  await fetchInboxEmails(gmail, email, db);
  await fetchSentEmails(gmail, email, db);

  saveDatabase();
}

// ── Start polling all connected accounts every 2 minutes ─────────────────────
function startPolling(redirectUri) {
  const run = async () => {
    const accounts = listConnectedAccounts();
    if (accounts.length === 0) return;
    for (const email of accounts) {
      await fetchNewEmails(email, redirectUri);
    }
  };

  run();
  setInterval(run, POLL_INTERVAL_MS);
  console.log('[Gmail] Polling started — checking every 2 minutes (inbox + sent)');
}

module.exports = {
  saveOAuthCredentials,
  loadOAuthCredentials,
  getAuthUrl,
  handleCallback,
  listConnectedAccounts,
  disconnectAccount,
  startPolling,
};
