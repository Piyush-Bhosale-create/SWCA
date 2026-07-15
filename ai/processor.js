// ai/processor.js
// SW.CA1 — AI Processing (M4, updated M9.5, updated M11.5, updated M11.6)
//
// Pass 1 — Local Ollama       : category, urgency, service_name (fast classification)
// Pass 2 — External or Ollama : summary + service confirmation with full conversation context
// Pass 3 — External or Ollama : thread grouping, running summary update, resolution detection
//
// Pass 3 is new in M11.5. It runs AFTER Pass 1 and Pass 2 complete, only for
// incoming messages from linked clients. It is never time-critical — grouping a
// message into a thread within 30 seconds is perfectly acceptable.
//
// Pass 3 uses the same external AI setting as Pass 2. If the CA has configured
// Groq / Gemini / OpenAI, Pass 3 uses it. If local only, Pass 3 uses Ollama.
// On weak devices, configuring an external model is strongly recommended.
//
// M11.6 adds runDeadlineEngine() — pure date logic, no AI calls.
// Runs every 30s alongside the AI loop. Initialises filing periods, advances them
// when all subtasks are marked Done, and auto-populates clients.next_deadline
// from deadline_rules. Respects deadline_override_flag — never overwrites a
// date the CA has set manually.
//
// M11.8 fixes GSTR-9 blocking the monthly GST period advance.
// The subtask-completion check now filters by subtask.frequency — annual subtasks
// (GSTR-9) are excluded when evaluating whether a monthly period is complete.
// NULL frequency = backward compatible, counts for any period type.

const fetch = require('node-fetch');
const { getDb, saveDatabase } = require('../src/database');
const { callExternal } = require('./external');

let aiProcessing     = false;
let aiLastRun        = null;
let aiProcessedCount = 0;

// ── Main processing loop ──────────────────────────────────────────────────────

async function processMessages() {
  if (aiProcessing) return;
  const db = getDb();
  if (!db) return;

  // Only count incoming unprocessed messages — outgoing are stored with processed=1
  let pending = 0;
  try {
    const r = db.exec(`
      SELECT COUNT(*) FROM messages
      WHERE processed = 0 AND (direction = 'incoming' OR direction IS NULL)
    `);
    if (r.length) pending = r[0].values[0][0];
  } catch (e) { return; }

  // Also run auto-resolve sweep even when no new messages are pending
  await autoResolveStaleThreads(db);

  // Deadline engine — runs every cycle regardless of pending message count
  runDeadlineEngine(db);

  // M12 — Smart Alerts engine. Piggybacks on this same 30s cycle rather than
  // running on a separate timer, per the CA's request.
  runAlertEngine(db);

  if (pending === 0) { aiLastRun = new Date(); return; }

  // ── Read AI settings ───────────────────────────────────────────────────────
  let aiModel        = 'gemma3:1b';
  let externalModel  = 'local';
  let externalApiKey = '';
  let threadWindowDays = 7;
  try {
    const sr = db.exec(`
      SELECT key, value FROM settings
      WHERE key IN ('ai_model','external_model','external_api_key','thread_window_days')
    `);
    if (sr.length && sr[0].values.length) {
      sr[0].values.forEach(([k, v]) => {
        if (k === 'ai_model'           && v) aiModel           = v;
        if (k === 'external_model'     && v) externalModel     = v;
        if (k === 'external_api_key'   && v) externalApiKey    = v;
        if (k === 'thread_window_days' && v) threadWindowDays  = parseInt(v) || 7;
      });
    }
  } catch (e) {}

  const useExternal = externalModel !== 'local' && Boolean(externalApiKey);

  aiProcessing = true;
  console.log(`\n[AI] Processing ${pending} message(s) | Pass 1: ${aiModel} | Pass 2+3: ${useExternal ? externalModel : 'ollama (local)'}`);

  // ── Load service context once for this batch ───────────────────────────────
  let serviceContext    = 'GST, ITR, TDS';
  let knownServiceNames = [];
  try {
    const sr = db.exec(`SELECT id, name FROM services ORDER BY name ASC`);
    if (sr.length && sr[0].values.length) {
      const services = sr[0].values.map(r => ({ id: r[0], name: r[1] }));
      knownServiceNames = services.map(s => s.name.toLowerCase());
      const mappings = services.map(svc => {
        const dr = db.exec(`SELECT doc_type FROM service_document_map WHERE service_id = ?`, [svc.id]);
        const docs = (dr.length && dr[0].values.length)
          ? dr[0].values.map(r => r[0]).join(', ')
          : 'no documents defined';
        return `${svc.name} (documents: ${docs})`;
      });
      serviceContext = mappings.join(' | ');
    }
  } catch (e) {}

  // ── Fetch unprocessed incoming messages ────────────────────────────────────
  let messages = [];
  for (const cols of [
    'id,source,sender_name,sender_email,sender_phone,subject,body',
    'id,source,sender_name,sender_email,sender_phone,subject',
  ]) {
    try {
      const r = db.exec(`
        SELECT ${cols},
          (SELECT GROUP_CONCAT(filename, ', ') FROM attachments WHERE message_id = m.id) AS attachment_names
        FROM messages m
        WHERE processed = 0 AND (direction = 'incoming' OR direction IS NULL)
        LIMIT 10
      `);
      if (r.length) {
        const colNames = r[0].columns;
        messages = r[0].values.map(row => {
          const obj = {};
          colNames.forEach((c, i) => obj[c] = row[i]);
          return obj;
        });
      }
      break;
    } catch (e) { continue; }
  }

  // ── Process each message ───────────────────────────────────────────────────

  for (const msg of messages) {
    try {
      const bodyText    = msg.body             ? String(msg.body).substring(0, 500) : '';
      const attachNames = msg.attachment_names ? String(msg.attachment_names)       : '';
      const sourceType  = msg.source === 'whatsapp' ? 'WhatsApp message' : 'email';
      const senderLabel = msg.sender_name || msg.sender_phone || msg.sender_email || 'Unknown';

      let contentLine = '';
      if (bodyText)         contentLine = 'Content: ' + bodyText;
      else if (attachNames) contentLine = 'Content: (no message body — attachment only)';
      const attachLine = attachNames ? `Attachment filenames: ${attachNames}\n` : '';

      // ── PASS 1 — Local Ollama ──────────────────────────────────────────────
      // Fast classification: category, urgency, spam, service_name
      // Always runs locally — never on external AI

      const pass1Prompt =
`You are a compliance assistant for a CA firm in India. Analyze this ${sourceType} and reply with ONLY a valid JSON object — no explanation, no markdown.

From: ${senderLabel}
${msg.source !== 'whatsapp' ? 'Subject: ' + (msg.subject || '(no subject)') + '\n' : ''}${attachLine}${contentLine}

Reply with exactly this JSON:
{"category":"Other","urgency":"Medium","summary":"One sentence description","service_name":null}

Allowed values:
- category: Invoice, Request, Inquiry, Complaint, Payment, Spam, Other
- urgency: High, Medium, Low
- summary: one sentence, max 15 words
- service_name: one of these services or null if you cannot tell: ${serviceContext}`;

      const pass1Promise = fetch('http://localhost:11434/api/generate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model: aiModel, prompt: pass1Prompt, stream: false, format: 'json' }),
      }).then(async r => {
        if (!r.ok) throw new Error('Ollama HTTP ' + r.status);
        const data    = await r.json();
        const rawText = (data.response || '').replace(/```json\n?|\n?```/g, '').trim();
        let parsed = {};
        try { parsed = JSON.parse(rawText); }
        catch (e) { const m = rawText.match(/\{[\s\S]*?\}/); if (m) try { parsed = JSON.parse(m[0]); } catch (e2) {} }
        return parsed;
      }).catch(e => {
        console.error(`[AI] Pass 1 error #${msg.id}:`, e.message);
        return {};
      });

      // ── PASS 2 — External or Ollama ────────────────────────────────────────
      // Richer summary + service confirmation using recent conversation context
      // Fetches last 5 messages from this sender (incoming + outgoing) for full picture

      const senderFilter = msg.sender_email
        ? `LOWER(sender_email) = LOWER('${msg.sender_email.replace(/'/g, "''")}')`
        : msg.sender_phone
          ? `sender_phone = '${String(msg.sender_phone).replace(/'/g, "''")}'`
          : null;

      let contextLines = '';
      if (senderFilter) {
        try {
          // Now includes outgoing messages (direction = 'outgoing') for full thread context
          const cr = db.exec(`
            SELECT ai_summary, category, service_name, direction
            FROM messages
            WHERE ${senderFilter} AND processed = 1 AND id != ${msg.id}
            ORDER BY received_at DESC LIMIT 6
          `);
          if (cr.length && cr[0].values.length) {
            contextLines = cr[0].values.map(row => {
              const dir    = row[3] === 'outgoing' ? 'CA replied' : 'Client said';
              const svc    = row[2] ? ' / ' + row[2] : '';
              const cat    = row[1] || 'Other';
              const summ   = row[0] || '(no summary)';
              return `- [${dir}] ${summ} [${cat}${svc}]`;
            }).join('\n');
          }
        } catch (e) {}
      }

      const pass2Prompt =
`You are a compliance assistant for a CA firm in India. Summarize what the CURRENT MESSAGE is saying. Use conversation history only for context — do not summarize the history itself.

Sender: ${senderLabel}
${attachLine}Current message: ${bodyText || '(no body)'}
${contextLines ? `\nRecent conversation with this sender:\n${contextLines}\n` : ''}
Reply with ONLY a valid JSON object — no explanation, no markdown:
{"summary":"One sentence max 15 words","service_name":null,"doc_types":[]}

Rules:
- summary: one sentence, max 15 words, describe what the CURRENT MESSAGE is saying
- service_name: must be one of these or null: ${serviceContext}
- doc_types: array of document names that were RECEIVED or ATTACHED in this message. Use exact names from the service document list above. Return [] if no documents received.`;

      let pass2Promise;
      if (useExternal) {
        // Use callExternalRaw so we can extract doc_types alongside summary and service_name.
        // callExternal (external.js) only returns {summary, service_name} — too narrow for M11.7.
        pass2Promise = callExternalRaw(pass2Prompt, externalModel, externalApiKey).then(raw => {
          if (!raw) return null;
          return {
            summary:      typeof raw.summary === 'string'                 ? raw.summary.substring(0, 200)      : null,
            service_name: raw.service_name && raw.service_name !== 'null' ? String(raw.service_name).substring(0, 50) : null,
            doc_types:    Array.isArray(raw.doc_types) ? raw.doc_types.filter(d => typeof d === 'string') : [],
          };
        });
      } else if (contextLines) {
        pass2Promise = fetch('http://localhost:11434/api/generate', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model: aiModel, prompt: pass2Prompt, stream: false, format: 'json' }),
        }).then(async r2 => {
          if (!r2.ok) return null;
          const d2 = await r2.json();
          const t2 = (d2.response || '').replace(/```json\n?|\n?```/g, '').trim();
          let p2 = {};
          try { p2 = JSON.parse(t2); }
          catch (e) { const m = t2.match(/\{[\s\S]*?\}/); if (m) try { p2 = JSON.parse(m[0]); } catch (e2) {} }
          return {
            summary:      typeof p2.summary === 'string'                ? p2.summary.substring(0, 200)      : null,
            service_name: p2.service_name && p2.service_name !== 'null' ? String(p2.service_name).substring(0, 50) : null,
            doc_types:    Array.isArray(p2.doc_types) ? p2.doc_types.filter(d => typeof d === 'string') : [],
          };
        }).catch(() => null);
      } else {
        pass2Promise = Promise.resolve(null);
      }

      // ── Fire Pass 1 and Pass 2 simultaneously ──────────────────────────────
      const [pass1Result, pass2Result] = await Promise.all([pass1Promise, pass2Promise]);

      // ── Merge results ──────────────────────────────────────────────────────
      const CATS     = ['Invoice','Request','Inquiry','Complaint','Payment','Spam','Other'];
      const URGS     = ['High','Medium','Low'];
      const category = CATS.includes(pass1Result?.category) ? pass1Result.category : 'Other';
      const urgency  = URGS.includes(pass1Result?.urgency)  ? pass1Result.urgency  : 'Medium';

      // Summary: prefer Pass 2 (has conversation context), fall back to Pass 1
      const pass1Summary = typeof pass1Result?.summary === 'string' ? pass1Result.summary.substring(0, 200) : '';
      const summary      = pass2Result?.summary || pass1Summary;

      // Service: prefer Pass 2, fall back to Pass 1, validate against DB
      let serviceName = null;
      for (const candidate of [pass2Result?.service_name, pass1Result?.service_name]) {
        if (candidate && candidate !== 'null') {
          const c = String(candidate).trim();
          if (knownServiceNames.includes(c.toLowerCase())) { serviceName = c; break; }
        }
      }

      // Extract doc_types from Pass 2 for checklist writing in Pass 3 (M11.7)
      const docTypes = Array.isArray(pass2Result?.doc_types) ? pass2Result.doc_types : [];

      // Write Pass 1 + 2 results to DB
      db.run(
        `UPDATE messages SET category=?, urgency=?, ai_summary=?, service_name=?, processed=1 WHERE id=?`,
        [category, urgency, summary, serviceName || null, msg.id]
      );
      saveDatabase();
      aiProcessedCount++;
      console.log(`[AI] ✅ #${msg.id} → ${category} / ${urgency} / service: ${serviceName || 'none'} | pass2: ${pass2Result ? (useExternal ? externalModel : 'ollama') : 'skipped'}`);

      // ── PASS 3 — Thread grouping + resolution detection ────────────────────
      // Runs after Pass 1+2, only for messages from linked clients.
      // Uses same external/local routing as Pass 2.
      // Never blocks the inbox — runs async, failures are silent.
      await runPass3(db, msg, serviceName, summary, contextLines, useExternal, externalModel, externalApiKey, aiModel, threadWindowDays, docTypes);

    } catch (e) {
      console.error(`[AI] ❌ Message ${msg.id}:`, e.message);
      try { db.run(`UPDATE messages SET processed=1 WHERE id=?`, [msg.id]); saveDatabase(); } catch (e2) {}
    }
  }

  aiProcessing = false;
  aiLastRun    = new Date();
  console.log(`[AI] Done.\n`);
}


// ── PASS 3 — Thread matching, running summary, resolution detection ────────────
//
// Step 1: Is this sender linked to a client? If not, skip entirely.
// Step 2: Is there an open conversation for this client + service within the time window?
//         Yes → fold this message into it (update message_count, last_message_at)
//         No  → create a new conversation record
// Step 3: Build full thread context (all messages in this conversation)
// Step 4: Ask AI to update running_summary and check for resolution
//         Resolution check covers Option 2 (AI detects closure) and Option 3 (document received)
// Step 5: If resolved → close thread, generate timeline entry
//         If not → update running_summary and move on

async function runPass3(db, msg, serviceName, currentSummary, contextLines, useExternal, externalModel, externalApiKey, aiModel, threadWindowDays, docTypes = []) {
  try {
    // ── Step 1: Check if sender is linked to a client ──────────────────────
    const senderFilter = msg.sender_email
      ? `LOWER(cs.value) = LOWER('${msg.sender_email.replace(/'/g, "''")}')`
      : msg.sender_phone
        ? `cs.value = '${String(msg.sender_phone).replace(/'/g, "''")}'`
        : null;

    if (!senderFilter) return; // no identifier — can't look up client

    const sourceType = msg.source === 'gmail' ? 'email' : 'whatsapp';
    const clientRow  = db.exec(`
      SELECT cs.client_id, c.name
      FROM client_sources cs
      JOIN clients c ON c.id = cs.client_id
      WHERE cs.type = ? AND ${senderFilter}
      LIMIT 1
    `, [sourceType]);

    if (!clientRow.length || !clientRow[0].values.length) return; // unlinked sender — skip

    const clientId   = clientRow[0].values[0][0];
    const clientName = clientRow[0].values[0][1];

    // ── Step 1b: Document checklist auto-marking (M11.7) ──────────────────
    // Pass 2 may have identified specific documents received in this message.
    // Now that we have the client_id, we can match them against service_document_map
    // and write confirmed matches to document_checklist_status.
    // AI auto-marks are skipped if the CA has manually_set = 1 on that entry.
    if (docTypes.length > 0 && serviceName) {
      try {
        const svcRow = db.exec(`
          SELECT cs.service_id, cs.current_period, dr.rule_type
          FROM client_services cs
          JOIN services s ON s.id = cs.service_id
          LEFT JOIN deadline_rules dr ON dr.service_id = cs.service_id
          WHERE cs.client_id = ? AND LOWER(s.name) = LOWER(?)
          LIMIT 1
        `, [clientId, serviceName]);

        if (svcRow.length && svcRow[0].values.length) {
          const [serviceId, currentPeriod, ruleType] = svcRow[0].values[0];
          const period = currentPeriod || getCurrentPeriod(ruleType || 'monthly');

          // Get known doc_types for this service (original casing preserved)
          const knownDocsRes = db.exec(
            `SELECT doc_type FROM service_document_map WHERE service_id = ?`,
            [serviceId]
          );
          const knownDocs = knownDocsRes.length && knownDocsRes[0].values.length
            ? knownDocsRes[0].values.map(r => r[0])
            : [];

          const now = new Date().toISOString();
          let docsMarked = 0;

          for (const rawDocType of docTypes) {
            const docLower = rawDocType.toLowerCase().trim();
            // Prefer exact (case-insensitive) match; fall back to "extracted string
            // contains a known doc type name" (handles "GSTR-2B PDF" → "GSTR-2B").
            let matched = knownDocs.find(kd => kd.toLowerCase() === docLower);
            if (!matched) matched = knownDocs.find(kd => docLower.includes(kd.toLowerCase()));
            if (!matched) continue;

            // ON CONFLICT: only update if CA has NOT manually set this entry
            db.run(`
              INSERT INTO document_checklist_status
                (client_id, service_id, period, doc_type, status, received_at, source_message_id, manually_set)
              VALUES (?, ?, ?, ?, 'received', ?, ?, 0)
              ON CONFLICT(client_id, service_id, period, doc_type) DO UPDATE SET
                status            = CASE WHEN manually_set = 1 THEN status            ELSE 'received'                  END,
                received_at       = CASE WHEN manually_set = 1 THEN received_at       ELSE excluded.received_at        END,
                source_message_id = CASE WHEN manually_set = 1 THEN source_message_id ELSE excluded.source_message_id  END
            `, [clientId, serviceId, period, matched, now, msg.id]);

            docsMarked++;
          }

          if (docsMarked > 0) {
            saveDatabase();
            console.log(`[AI] Pass 3 — Marked ${docsMarked} doc(s) received for ${clientName} (${serviceName} / ${period})`);

            // M12 — "New document received" notification. Event-driven (tied
            // to this message), not a recurring condition, so this is a plain
            // one-shot insert rather than going through _fireOrResolve's
            // dedup/resolve machinery.
            try {
              db.run(`
                INSERT INTO notifications (type, client_id, service_id, period, message, status)
                VALUES ('new_document_received', ?, ?, ?, ?, 'active')
              `, [clientId, serviceId, period, `${clientName} — new document received for ${serviceName} (${period})`]);
            } catch (e) {
              console.error('[Alerts] new_document_received insert error:', e.message);
            }
          }
        }
      } catch (e) {
        console.error('[AI] Pass 3 — Doc checklist error:', e.message);
      }
    }

    // ── Step 2: Find or create conversation thread ─────────────────────────
    const windowCutoff = new Date(Date.now() - threadWindowDays * 24 * 60 * 60 * 1000).toISOString();

    const convRow = db.exec(`
      SELECT id, message_count, running_summary
      FROM conversations
      WHERE client_id = ?
        AND (service_tag = ? OR (service_tag IS NULL AND ? IS NULL))
        AND status = 'open'
        AND last_message_at >= ?
      ORDER BY last_message_at DESC
      LIMIT 1
    `, [clientId, serviceName || null, serviceName || null, windowCutoff]);

    let conversationId;
    let isNewThread = false;
    let currentMessageCount = 1;

    if (convRow.length && convRow[0].values.length) {
      // Existing open thread — fold this message in
      conversationId      = convRow[0].values[0][0];
      currentMessageCount = (convRow[0].values[0][1] || 0) + 1;

      db.run(`
        UPDATE conversations
        SET message_count = ?, last_message_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [currentMessageCount, conversationId]);

    } else {
      // No matching open thread — start a new one
      isNewThread = true;
      db.run(`
        INSERT INTO conversations (client_id, service_tag, status, message_count, running_summary, last_message_at)
        VALUES (?, ?, 'open', 1, ?, CURRENT_TIMESTAMP)
      `, [clientId, serviceName || null, currentSummary || null]);

      const newConvRow   = db.exec(`SELECT last_insert_rowid()`);
      conversationId     = newConvRow[0].values[0][0];
    }

    // Link this message to the conversation
    db.run(`UPDATE messages SET conversation_id = ? WHERE id = ?`, [conversationId, msg.id]);
    saveDatabase();

    console.log(`[AI] Pass 3 — ${isNewThread ? 'New thread' : 'Thread updated'} #${conversationId} for ${clientName} (${serviceName || 'general'})`);

    // ── Step 3: Build full thread context for AI ───────────────────────────
    // Two-part fetch:
    //   Part A — incoming messages linked to this conversation by conversation_id
    //   Part B — outgoing CA replies to this client within the conversation window
    //
    // Outgoing messages are never assigned a conversation_id (Pass 3 only runs
    // on incoming messages). So they must be fetched separately by matching the
    // recipient phone/email against the client's linked sources, then merged
    // by received_at so the AI reads a natural back-and-forth.

    // Get the conversation's created_at so we only fetch outgoing messages
    // that fall within the conversation's lifetime
    const convTimeRow = db.exec(`
      SELECT created_at FROM conversations WHERE id = ?
    `, [conversationId]);
    const convCreatedAt = (convTimeRow.length && convTimeRow[0].values.length)
      ? convTimeRow[0].values[0][0]
      : new Date(0).toISOString();

    // Part A — incoming messages in this thread
    const incomingMsgs = db.exec(`
      SELECT body, direction, ai_summary, received_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY received_at ASC
    `, [conversationId]);

    // Part B — outgoing CA replies to this client since the thread started
    // Outgoing messages store the recipient's phone/email in sender_phone/sender_email
    // (this is the flip we did in gmail.js and whatsapp.js intentionally)
    let outgoingMsgs = { length: 0, values: [] };
    try {
      const linkedSources = db.exec(`
        SELECT type, value FROM client_sources WHERE client_id = ?
      `, [clientId]);

      if (linkedSources.length && linkedSources[0].values.length) {
        // Build OR conditions for each linked source
        const outgoingConditions = linkedSources[0].values.map(([type, value]) => {
          if (type === 'whatsapp') {
            return `(direction = 'outgoing' AND source = 'whatsapp' AND sender_phone = '${value.replace(/'/g, "''")}')`;
          } else {
            return `(direction = 'outgoing' AND source = 'gmail' AND LOWER(sender_email) = LOWER('${value.replace(/'/g, "''")}'))`;
          }
        }).join(' OR ');

        if (outgoingConditions) {
          outgoingMsgs = db.exec(`
            SELECT body, direction, ai_summary, received_at
            FROM messages
            WHERE (${outgoingConditions})
              AND received_at >= ?
            ORDER BY received_at ASC
          `, [convCreatedAt]);
        }
      }
    } catch (e) {
      console.error('[AI] Pass 3 — outgoing fetch error:', e.message);
    }

    // Merge incoming + outgoing, sort by received_at ascending
    const allThreadRows = [];
    if (incomingMsgs.length && incomingMsgs[0].values) {
      incomingMsgs[0].values.forEach(r => allThreadRows.push(r));
    }
    if (outgoingMsgs.length && outgoingMsgs[0] && outgoingMsgs[0].values) {
      outgoingMsgs[0].values.forEach(r => allThreadRows.push(r));
    }
    allThreadRows.sort((a, b) => new Date(a[3]) - new Date(b[3]));

    let threadContext = '';
    if (allThreadRows.length) {
      threadContext = allThreadRows.map(row => {
        const who     = row[1] === 'outgoing' ? 'CA' : 'Client';
        const content = (row[0] || row[2] || '').substring(0, 200);
        return `[${who}]: ${content}`;
      }).join('\n');
    }

    // ── Step 4: Ask AI to update running summary + check resolution ────────
    const pass3Prompt =
`You are a compliance assistant for a CA firm in India reviewing a client conversation thread.

Client: ${clientName}
Service: ${serviceName || 'General'}

Full conversation (oldest to newest, [CA] = CA's replies, [Client] = client messages):
${threadContext || currentSummary || '(no prior messages)'}

Tasks:
1. Write a single updated summary of the ENTIRE conversation (max 20 words).
   - Include what the CLIENT wanted AND what the CA said or did
   - Include key facts: amounts, locations, decisions, referrals given
   - Example: "Client wants GST registration in Pune, 5cr turnover. CA referred them to ABC firm."

2. Decide if this conversation is RESOLVED.
   Mark resolved = true when ANY of these are true:
   - Client said thank you / thanks / ok / noted / understood after CA replied
   - CA referred the client elsewhere and client acknowledged
   - CA gave a final answer and client has no further questions
   - Required document was received and confirmed
   Mark resolved = false when:
   - Client is still waiting for CA's reply
   - CA asked for information and client hasn't responded yet
   - Conversation is clearly still ongoing

Reply with ONLY a valid JSON object — no explanation, no markdown:
{"running_summary":"Summary max 20 words","resolved":false,"resolved_reason":null}

resolved_reason must be one of: "ai_detected", "document_received", or null`;

    let pass3Result = null;

    if (useExternal) {
      // Route to external AI — same provider as Pass 2
      const raw = await callExternal(pass3Prompt, externalModel, externalApiKey);
      // callExternal returns {summary, service_name} — we need raw text for Pass 3
      // So we call a direct parse here after getting the raw response
      // Note: callExternal already parses — we need to extend it slightly.
      // For now we re-call with a wrapper that returns full parsed JSON
      pass3Result = await callExternalRaw(pass3Prompt, externalModel, externalApiKey);
    } else {
      // Local Ollama
      try {
        const r3 = await fetch('http://localhost:11434/api/generate', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model: aiModel, prompt: pass3Prompt, stream: false, format: 'json' }),
        });
        if (r3.ok) {
          const d3  = await r3.json();
          const t3  = (d3.response || '').replace(/```json\n?|\n?```/g, '').trim();
          try { pass3Result = JSON.parse(t3); }
          catch (e) { const m = t3.match(/\{[\s\S]*?\}/); if (m) try { pass3Result = JSON.parse(m[0]); } catch (e2) {} }
        }
      } catch (e) {
        console.error(`[AI] Pass 3 local error:`, e.message);
      }
    }

    if (!pass3Result) {
      // AI failed — update running_summary with current message summary at minimum
      if (currentSummary) {
        db.run(`UPDATE conversations SET running_summary = ? WHERE id = ?`, [currentSummary, conversationId]);
        saveDatabase();
      }
      return;
    }

    // ── Step 5: Apply results ──────────────────────────────────────────────
    const newSummary     = typeof pass3Result.running_summary === 'string'
      ? pass3Result.running_summary.substring(0, 300)
      : currentSummary;
    const isResolved     = pass3Result.resolved === true;
    const resolvedReason = isResolved ? (pass3Result.resolved_reason || 'ai_detected') : null;

    if (isResolved) {
      // Close the thread
      db.run(`
        UPDATE conversations
        SET status = 'resolved', running_summary = ?, resolved_at = CURRENT_TIMESTAMP, resolved_reason = ?
        WHERE id = ?
      `, [newSummary, resolvedReason, conversationId]);

      // Auto-generate timeline entry so the CA sees the closed thread in the client profile
      const now     = new Date().toISOString();
      const reason  = resolvedReason === 'document_received'
        ? 'Document received — conversation closed automatically'
        : 'Conversation closed — query resolved';
      db.run(`
        INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
        VALUES (?, 'system', ?, ?, ?, ?)
      `, [clientId, `${reason}: ${newSummary}`, now, serviceName || null, now]);

      console.log(`[AI] Pass 3 — Thread #${conversationId} resolved (${resolvedReason})`);

    } else {
      // Still open — just update the running summary
      db.run(`
        UPDATE conversations SET running_summary = ? WHERE id = ?
      `, [newSummary, conversationId]);
    }

    saveDatabase();

  } catch (err) {
    // Pass 3 failures are silent — they never affect Pass 1/2 results
    console.error(`[AI] Pass 3 error for message #${msg.id}:`, err.message);
  }
}


// ── callExternalRaw — Pass 3 variant ─────────────────────────────────────────
// callExternal in external.js is tuned for Pass 2 (returns {summary, service_name}).
// Pass 3 needs a full arbitrary JSON response. This wrapper calls the same
// providers but returns the raw parsed object instead of reshaping it.

async function callExternalRaw(prompt, provider, apiKey) {
  const PROVIDERS = {
    'groq-llama-3.1-8b':  { type: 'openai-compat', url: 'https://api.groq.com/openai/v1/chat/completions',          model: 'llama-3.1-8b-instant'    },
    'groq-llama-3.3-70b': { type: 'openai-compat', url: 'https://api.groq.com/openai/v1/chat/completions',          model: 'llama-3.3-70b-versatile'  },
    'gemini-flash':        { type: 'gemini',        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', model: 'gemini-2.0-flash' },
    'openai-gpt4.1-nano':  { type: 'openai-compat', url: 'https://api.openai.com/v1/chat/completions',               model: 'gpt-4.1-nano'             },
  };

  const cfg = PROVIDERS[provider];
  if (!cfg || !apiKey) return null;

  try {
    let rawText = '';

    if (cfg.type === 'openai-compat') {
      const response = await fetch(cfg.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify({
          model: cfg.model, messages: [{ role: 'user', content: prompt }],
          temperature: 0.1, max_tokens: 300,
        }),
        timeout: 20000,
      });
      if (!response.ok) return null;
      const data = await response.json();
      rawText = data.choices?.[0]?.message?.content || '';

    } else if (cfg.type === 'gemini') {
      const response = await fetch(`${cfg.url}?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300 },
        }),
        timeout: 20000,
      });
      if (!response.ok) return null;
      const data = await response.json();
      rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    const clean = rawText.replace(/```json\n?|\n?```/g, '').trim();
    try { return JSON.parse(clean); }
    catch (e) {
      const m = clean.match(/\{[\s\S]*?\}/);
      if (m) try { return JSON.parse(m[0]); } catch (e2) {}
    }
    return null;

  } catch (e) {
    console.error(`[AI] callExternalRaw (${provider}) failed:`, e.message);
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// M11.6 — DEADLINE ENGINE
// Pure date logic — no AI calls. Runs on every 30-second cycle.
// ══════════════════════════════════════════════════════════════════════════════

// ── Helper: return the current filing period string for a given rule type ────
// Called when a client_services row has no current_period yet.
//
// Monthly   → "YYYY-MM"      e.g. "2026-06"
// Quarterly → "YYYY-QN"     e.g. "2026-Q1"  (Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar)
//             Year prefix = FY start year (April = start of Indian FY)
// Annual    → "FY-YYYY-YY"  e.g. "FY-2025-26"
//             Uses the most recently ended FY — the one clients are currently filing for.

function getCurrentPeriod(ruleType) {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1-indexed

  if (ruleType === 'monthly') {
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  if (ruleType === 'quarterly') {
    // Indian FY starts April. Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar.
    // fyYear = the year April fell in (= calendar year for Apr-Dec, previous year for Jan-Mar).
    const fyYear = month >= 4 ? year : year - 1;
    let q;
    if      (month >= 4 && month <= 6)   q = 1;
    else if (month >= 7 && month <= 9)   q = 2;
    else if (month >= 10 && month <= 12) q = 3;
    else                                  q = 4; // Jan-Mar
    return `${fyYear}-Q${q}`;
  }

  if (ruleType === 'annual') {
    // "Most recently ended FY" — what clients are currently filing for.
    // In Apr-Dec: previous FY ended March of this year → startYear = year-1
    // In Jan-Mar: previous FY ended March of last year → startYear = year-2
    const fyStartYear = month >= 4 ? year - 1 : year - 2;
    return `FY-${fyStartYear}-${String(fyStartYear + 1).slice(-2)}`;
  }

  // Fallback
  return `${year}-${String(month).padStart(2, '0')}`;
}


// ── Helper: calendar start/end dates for a period string ────────────────────

function getPeriodDates(ruleType, period) {
  if (ruleType === 'monthly') {
    const [year, month] = period.split('-').map(Number);
    const start = new Date(year, month - 1, 1);
    const end   = new Date(year, month, 0);      // last day of the month
    return {
      start: start.toISOString().split('T')[0],
      end:   end.toISOString().split('T')[0],
    };
  }

  if (ruleType === 'quarterly') {
    const match = period.match(/^(\d{4})-Q(\d)$/);
    if (!match) return { start: null, end: null };
    const fyYear = parseInt(match[1]);
    const q      = parseInt(match[2]);
    // Q1=Apr-Jun, Q2=Jul-Sep, Q3=Oct-Dec, Q4=Jan-Mar (of the NEXT calendar year)
    const bounds = {
      1: { sm: 4,  sy: fyYear,     em: 6,  ey: fyYear     },
      2: { sm: 7,  sy: fyYear,     em: 9,  ey: fyYear     },
      3: { sm: 10, sy: fyYear,     em: 12, ey: fyYear     },
      4: { sm: 1,  sy: fyYear + 1, em: 3,  ey: fyYear + 1 },
    };
    const b     = bounds[q];
    const start = new Date(b.sy, b.sm - 1, 1);
    const end   = new Date(b.ey, b.em, 0);  // last day of end month
    return {
      start: start.toISOString().split('T')[0],
      end:   end.toISOString().split('T')[0],
    };
  }

  if (ruleType === 'annual') {
    // "FY-2025-26" → Apr 1, 2025 to Mar 31, 2026
    const match = period.match(/^FY-(\d{4})-(\d{2,4})$/);
    if (!match) return { start: null, end: null };
    const startYear = parseInt(match[1]);
    const endYear   = match[2].length === 2 ? startYear + 1 : parseInt(match[2]);
    return {
      start: `${startYear}-04-01`,
      end:   `${endYear}-03-31`,
    };
  }

  return { start: null, end: null };
}


// ── Helper: calculate the filing deadline date for a given period ────────────
//
// Monthly   GSTR-1 June 2026 → June 20, 2026
// Quarterly TDS    Q1 2026   → July 31, 2026
// Annual    ITR    FY-2025-26 → July 31, 2026
//
// Extracted to src/deadlineEngine.js during M12 (shared with server.js —
// see that file's periodDeadline for the full history). Found this local
// copy had the same local-time-then-.toISOString() bug fixed in
// _subtaskDeadline back in M11.9; fixed now in the one shared copy.
// Aliased back to the original local name so no other line here changes.
const { periodDeadline: getPeriodDeadline, subtaskDeadline } = require('../src/deadlineEngine');


// ── Helper: advance to the next period ──────────────────────────────────────

function getNextPeriod(ruleType, currentPeriod) {
  if (ruleType === 'monthly') {
    const [year, month] = currentPeriod.split('-').map(Number);
    const next = new Date(year, month, 1); // month is 0-indexed in Date, so this gives next month
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
  }

  if (ruleType === 'quarterly') {
    const match = currentPeriod.match(/^(\d{4})-Q(\d)$/);
    if (!match) return null;
    const fyYear = parseInt(match[1]);
    const q      = parseInt(match[2]);
    if (q === 4) return `${fyYear + 1}-Q1`;
    return `${fyYear}-Q${q + 1}`;
  }

  if (ruleType === 'annual') {
    const match = currentPeriod.match(/^FY-(\d{4})-(\d{2,4})$/);
    if (!match) return null;
    const startYear = parseInt(match[1]);
    const endYear   = match[2].length === 2 ? startYear + 1 : parseInt(match[2]);
    return `FY-${endYear}-${String(endYear + 1).slice(-2)}`;
  }

  return null;
}


// ── Main deadline engine ─────────────────────────────────────────────────────
//
// Pass A — Period management
//   For every client_services row that has a deadline rule:
//   1. If current_period is NULL → initialise it from today's date.
//   2. Check whether ALL standard service subtasks for this client are Done.
//      (Standard = subtasks.client_id IS NULL — excludes one-off tasks from M10.5.)
//   3. If all Done → advance to next period, reset subtasks to Pending,
//      write a timeline entry so the CA can see the auto-reset in the profile.
//
// Pass B — Deadline population
//   For every client that does NOT have deadline_override_flag set:
//   compute the soonest upcoming deadline across all their services and write
//   it to clients.next_deadline. This is what Layer 2 displays.

function runDeadlineEngine(db) {
  try {
    const now = new Date();

    // ── Pass A: initialise periods and advance completed ones ─────────────────
    let engineRows = [];
    try {
      const r = db.exec(`
        SELECT cs.id, cs.client_id, cs.service_id, cs.current_period,
               cs.rule_type_override,
               dr.rule_type, dr.due_day, dr.due_month,
               s.name AS service_name
        FROM   client_services cs
        JOIN   services         s  ON s.id  = cs.service_id
        JOIN   deadline_rules   dr ON dr.service_id = cs.service_id
      `);
      if (r.length && r[0].values.length) engineRows = r[0].values;
    } catch (e) {
      // deadline_rules table doesn't exist yet on very old DBs — silently skip
      return;
    }

    let changed = false;

    for (const row of engineRows) {
      const [csId, clientId, serviceId, currentPeriod, ruleTypeOverride,
             ruleType, dueDay, dueMonth, serviceName] = row;

      // Effective cadence for THIS client+service — a per-client override
      // (e.g. a QRMP client on quarterly GST) wins over the service's own
      // default. due_day/due_month are NEVER overridden — those always come
      // from the service's own deadline_rules regardless of cadence.
      const effectiveRuleType = ruleTypeOverride || ruleType;
      const rule = { rule_type: effectiveRuleType, due_day: dueDay, due_month: dueMonth };

      // 1. Initialise period if not yet set
      let activePeriod = currentPeriod;
      if (!activePeriod) {
        activePeriod = getCurrentPeriod(effectiveRuleType);
        const dates  = getPeriodDates(effectiveRuleType, activePeriod);
        db.run(
          `UPDATE client_services SET current_period=?,period_start=?,period_end=? WHERE id=?`,
          [activePeriod, dates.start, dates.end, csId]
        );
        changed = true;
      }

      // 2. Check if all standard subtasks are Done for this client+service.
      //    M11.8: filter by frequency so annual subtasks (e.g. GSTR-9) do not
      //    block monthly period advance. NULL frequency = counts for any rule_type.
      //    Measured against the client's EFFECTIVE cadence, not always the
      //    service's own — so a QRMP client's quarterly subtasks are checked
      //    against 'quarterly', not the service's default 'monthly'.
      let total = 0, done = 0;
      try {
        const chk = db.exec(`
          SELECT COUNT(*)                                                    AS total,
                 SUM(CASE WHEN css.status = 'Done' THEN 1 ELSE 0 END)      AS done
          FROM   subtasks st
          LEFT JOIN client_subtask_status css
                 ON css.subtask_id = st.id AND css.client_id = ?
          WHERE  st.service_id = ? AND st.client_id IS NULL
            AND  (st.frequency IS NULL OR st.frequency = ?)
        `, [clientId, serviceId, effectiveRuleType]);
        if (chk.length && chk[0].values.length) {
          total = chk[0].values[0][0] || 0;
          done  = chk[0].values[0][1] || 0;
        }
      } catch (e) {}

      // 3. Advance period if everything is Done
      if (total > 0 && done >= total) {
        const nextPeriod   = getNextPeriod(effectiveRuleType, activePeriod);
        if (!nextPeriod) continue;

        const nextDates    = getPeriodDates(effectiveRuleType, nextPeriod);
        const nextDeadline = getPeriodDeadline(rule, nextPeriod);

        // Update period on client_services
        db.run(
          `UPDATE client_services SET current_period=?,period_start=?,period_end=? WHERE id=?`,
          [nextPeriod, nextDates.start, nextDates.end, csId]
        );

        // Reset standard subtasks for this client+service to Pending.
        //
        // BUG FIX: this used to reset EVERY standard subtask tied to the
        // service, with no frequency check — so an annual subtask (e.g.
        // GSTR-9) marked Done got silently wiped back to Pending every time
        // a monthly period advanced, even though nothing about the annual
        // cycle actually changed. Fixed by applying the same frequency
        // filter used in step 2's completion check above: only subtasks
        // whose frequency matches the cadence that just advanced (or have
        // no frequency set, meaning they apply under any cadence) get reset.
        db.run(`
          UPDATE client_subtask_status
          SET    status = 'Pending', updated_at = CURRENT_TIMESTAMP
          WHERE  client_id = ?
            AND  subtask_id IN (
                   SELECT id FROM subtasks
                   WHERE service_id = ? AND client_id IS NULL
                     AND (frequency IS NULL OR frequency = ?)
                 )
        `, [clientId, serviceId, effectiveRuleType]);

        // Timeline entry visible in the client profile
        const ts      = now.toISOString();
        const content = nextDeadline
          ? `${serviceName} period ${activePeriod} completed — next deadline auto-set to ${nextDeadline}`
          : `${serviceName} period ${activePeriod} completed — advancing to ${nextPeriod}`;

        db.run(`
          INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
          VALUES (?, 'system', ?, ?, ?, ?)
        `, [clientId, content, ts, serviceName, ts]);

        console.log(`[Engine] Period advanced: Client ${clientId} / ${serviceName} → ${nextPeriod}${nextDeadline ? ' (deadline ' + nextDeadline + ')' : ''}`);
        changed = true;
      }
    }

    // ── Pass B: recompute next_deadline for clients without an override ────────
    let clientRows = [];
    try {
      const cr = db.exec(`SELECT id, deadline_override_flag FROM clients`);
      if (cr.length && cr[0].values.length) clientRows = cr[0].values;
    } catch (e) {}

    for (const [clientId, overrideFlag] of clientRows) {
      if (overrideFlag) continue; // CA manually set the date — leave it alone

      // Find the soonest upcoming deadline across all services for this client
      let svcRows = [];
      try {
        const sr = db.exec(`
          SELECT cs.current_period, cs.rule_type_override, dr.rule_type, dr.due_day, dr.due_month
          FROM   client_services cs
          JOIN   deadline_rules  dr ON dr.service_id = cs.service_id
          WHERE  cs.client_id = ? AND cs.current_period IS NOT NULL
        `, [clientId]);
        if (sr.length && sr[0].values.length) svcRows = sr[0].values;
      } catch (e) {}

      if (!svcRows.length) continue;

      let soonest = null;
      for (const [period, ruleTypeOverride, ruleType, dueDay, dueMonth] of svcRows) {
        const rule     = { rule_type: ruleTypeOverride || ruleType, due_day: dueDay, due_month: dueMonth };
        const deadline = getPeriodDeadline(rule, period);
        if (deadline && (!soonest || deadline < soonest)) soonest = deadline;
      }

      if (soonest) {
        db.run(`UPDATE clients SET next_deadline = ? WHERE id = ?`, [soonest, clientId]);
        changed = true;
      }
    }

    if (changed) saveDatabase();

  } catch (err) {
    console.error('[Engine] Deadline engine error:', err.message);
  }
}


// ── M12 — Smart Alerts engine ────────────────────────────────────────────────
//
// Runs every 30s in the same cycle as runDeadlineEngine (called right after
// it, from processMessages() below) — this is the "piggyback on the existing
// sweep" the CA asked for, rather than a separate timer.
//
// Reuses periodEndDate/subtaskDeadline/periodDeadline from
// src/deadlineEngine.js — the same shared, bug-fixed date math the
// Compliance Overview route uses. The active-subtask / overdue-subtask
// COMPUTATION below intentionally mirrors that route's logic rather than
// importing it — server.js already requires this file, so this file
// importing back from server.js would create a circular require. If the
// active-subtask branch logic in /api/compliance/overview ever changes,
// this should be updated to match (same rule that already applied to the
// old duplicated getPeriodDeadline before this session's extraction).
//
// Notification instance key: (type, client_id, service_id, subtask_id, period).
// subtask_id/period are NULL for alert types that aren't subtask/period-scoped
// (client_not_contacted, conflict_detected).
//
// Lifecycle: 'active' until the CA dismisses it (→ 'dismissed', stays hidden
// for that exact instance key) or this sweep finds the condition no longer
// true (→ 'resolved', auto-cleared). A dismissed row is never silently
// recreated for the same key — only a genuinely new key (new period, new
// overdue subtask, etc.) creates a fresh notification.

// _fireOrResolve — the shared insert/refresh/resolve logic for one
// notification instance key, for the condition-based alert types
// (everything except 'new_document_received', which is a one-shot event —
// see the Pass 3 hook further down — and 'conflict_detected', which is
// fired directly from the PATCH routes in server.js).
function _fireOrResolve(db, { type, client_id, service_id = null, subtask_id = null, period = null, message, conditionTrue }) {
  const existing = db.exec(`
    SELECT id, status FROM notifications
    WHERE type = ? AND client_id = ? AND service_id IS ? AND subtask_id IS ? AND period IS ?
  `, [type, client_id, service_id, subtask_id, period]);
  const row = (existing.length && existing[0].values.length) ? existing[0].values[0] : null;
  const now = new Date().toISOString();

  if (conditionTrue) {
    if (!row || row[1] === 'resolved') {
      if (row) {
        // Condition genuinely recurred after previously clearing — reactivate
        // rather than insert a second row for the same instance key.
        db.run(`UPDATE notifications SET status = 'active', message = ?, resolved_at = NULL WHERE id = ?`, [message, row[0]]);
      } else {
        db.run(`
          INSERT INTO notifications (type, client_id, service_id, subtask_id, period, message, status)
          VALUES (?, ?, ?, ?, ?, ?, 'active')
        `, [type, client_id, service_id, subtask_id, period, message]);
      }
    } else if (row[1] === 'active') {
      // Refresh display text only (e.g. day counts) — doesn't touch status/created_at.
      db.run(`UPDATE notifications SET message = ? WHERE id = ?`, [message, row[0]]);
    }
    // row exists and is 'dismissed' → leave it alone, do not resurrect
  } else if (row && row[1] === 'active') {
    db.run(`UPDATE notifications SET status = 'resolved', resolved_at = ? WHERE id = ?`, [now, row[0]]);
  }
}

function runAlertEngine(db) {
  try {
    const today = new Date().toISOString().split('T')[0];

    // ── Client-not-contacted threshold default ───────────────────────────────
    let defaultContactAlertDays = 5;
    try {
      const sr = db.exec(`SELECT value FROM settings WHERE key = 'default_contact_alert_days'`);
      if (sr.length && sr[0].values.length) {
        defaultContactAlertDays = parseInt(sr[0].values[0][0], 10) || 5;
      }
    } catch (e) {}

    // ── Client-not-contacted check ────────────────────────────────────────────
    // Last INCOMING message per client, via the same client_sources join
    // pattern Pass 3 uses to resolve a sender to a client_id. Deliberately
    // direction='incoming' only — a CA reply should not reset this clock;
    // the point is to flag clients who have gone quiet, not threads with no
    // recent activity of any kind.
    try {
      const contactRes = db.exec(`
        SELECT cs.client_id, c.name, c.contact_alert_days, MAX(m.received_at) AS last_incoming
        FROM client_sources cs
        JOIN clients c ON c.id = cs.client_id
        JOIN messages m ON (
          (cs.type = 'email'    AND LOWER(m.sender_email) = LOWER(cs.value))
          OR (cs.type = 'whatsapp' AND m.sender_phone = cs.value)
        )
        WHERE (m.direction = 'incoming' OR m.direction IS NULL)
        GROUP BY cs.client_id
      `);
      if (contactRes.length && contactRes[0].values.length) {
        for (const [clientId, clientName, ownThreshold, lastIncoming] of contactRes[0].values) {
          if (!lastIncoming) continue;
          const daysSince = Math.floor((new Date(today) - new Date(lastIncoming.split(' ')[0])) / 86400000);
          const threshold = ownThreshold != null ? ownThreshold : defaultContactAlertDays;
          const conditionTrue = daysSince >= threshold;
          _fireOrResolve(db, {
            type: 'client_not_contacted',
            client_id: clientId,
            message: `No message from ${clientName} in ${daysSince} day(s)`,
            conditionTrue,
          });
        }
      }
    } catch (e) {
      console.error('[Alerts] Client-not-contacted check error:', e.message);
    }

    // ── Per client×service: deadline / docs / overdue / docs-ready ──────────
    let baseRows = [];
    try {
      const baseRes = db.exec(`
        SELECT
          c.id AS client_id, c.name AS client_name,
          s.id AS service_id, s.name AS service_name,
          cs.current_period, cs.rule_type_override,
          dr.rule_type, dr.due_day AS svc_due_day, dr.due_month AS svc_due_month, dr.alert_days AS svc_alert_days
        FROM clients c
        JOIN client_services cs ON cs.client_id = c.id
        JOIN services s        ON s.id = cs.service_id
        LEFT JOIN deadline_rules dr ON dr.service_id = s.id
        WHERE cs.current_period IS NOT NULL
      `);
      if (baseRes.length && baseRes[0].values.length) {
        const cols = baseRes[0].columns;
        baseRows = baseRes[0].values.map(row => {
          const r = {}; cols.forEach((c, i) => r[c] = row[i]);
          return r;
        });
      }
    } catch (e) { console.error('[Alerts] Base query error:', e.message); return; }

    if (!baseRows.length) return;

    const stRes  = db.exec(`SELECT id, service_id, name, sort_order, frequency, due_day, due_month_offset, alert_days FROM subtasks WHERE client_id IS NULL`);
    const cssRes = db.exec(`SELECT client_id, subtask_id, status FROM client_subtask_status`);
    const sdmRes = db.exec(`SELECT id, service_id, doc_type, subtask_id FROM service_document_map`);
    const docRes = db.exec(`
      SELECT dcs.client_id, dcs.service_id, dcs.doc_type, dcs.status
      FROM document_checklist_status dcs
      JOIN client_services cs ON cs.client_id = dcs.client_id AND cs.service_id = dcs.service_id
      WHERE dcs.period = cs.current_period
    `);

    const subtasksByService = {};
    if (stRes.length && stRes[0].values.length) {
      const cols = stRes[0].columns;
      stRes[0].values.forEach(row => {
        const r = {}; cols.forEach((c, i) => r[c] = row[i]);
        (subtasksByService[r.service_id] = subtasksByService[r.service_id] || []).push(r);
      });
    }
    const cssMap = {};
    if (cssRes.length && cssRes[0].values.length) {
      cssRes[0].values.forEach(([cid, stid, status]) => { cssMap[`${cid}:${stid}`] = status; });
    }
    const sdmByService = {};
    if (sdmRes.length && sdmRes[0].values.length) {
      sdmRes[0].values.forEach(([id, sid, doc_type, subtask_id]) => {
        (sdmByService[sid] = sdmByService[sid] || []).push({ id, doc_type, subtask_id });
      });
    }
    const docStatusMap = {};
    if (docRes.length && docRes[0].values.length) {
      docRes[0].values.forEach(([cid, sid, doc_type, status]) => {
        docStatusMap[`${cid}:${sid}:${String(doc_type).toLowerCase()}`] = status;
      });
    }

    for (const r of baseRows) {
      const effectiveRuleType = r.rule_type_override || r.rule_type;

      const allSubtasks = (subtasksByService[r.service_id] || []).filter(
        st => !st.frequency || st.frequency === effectiveRuleType
      );

      const enriched = allSubtasks.map(st => {
        const status = cssMap[`${r.client_id}:${st.id}`] || 'Pending';
        const ruleTypeForThis = st.frequency || effectiveRuleType;
        const deadline = subtaskDeadline(st, r.current_period, ruleTypeForThis);
        const linkedDocs = (sdmByService[r.service_id] || []).filter(d => d.subtask_id === st.id);
        const docsReceived = linkedDocs.filter(d =>
          docStatusMap[`${r.client_id}:${r.service_id}:${String(d.doc_type).toLowerCase()}`] === 'received'
        ).length;
        return { ...st, status, deadline, docsExpected: linkedDocs.length, docsReceived };
      });

      const dated = enriched
        .filter(s => s.deadline)
        .sort((a, b) => a.deadline === b.deadline ? a.sort_order - b.sort_order : (a.deadline < b.deadline ? -1 : 1));

      const overdueSubtasks = dated.filter(s => s.deadline < today && s.status !== 'Done');
      const activeSubtask   = dated.find(s => s.status !== 'Done' && s.deadline >= today);

      // ── deadline_missed — resolve stale ones, then fire current ones ───────
      try {
        const stillOverdueIds = new Set(overdueSubtasks.map(s => s.id));
        const activeMissed = db.exec(`
          SELECT id, subtask_id, period FROM notifications
          WHERE type = 'deadline_missed' AND client_id = ? AND service_id = ? AND status = 'active'
        `, [r.client_id, r.service_id]);
        if (activeMissed.length && activeMissed[0].values.length) {
          for (const [notifId, subtaskId, notifPeriod] of activeMissed[0].values) {
            const stillValid = notifPeriod === r.current_period && stillOverdueIds.has(subtaskId);
            if (!stillValid) {
              db.run(`UPDATE notifications SET status='resolved', resolved_at=? WHERE id=?`, [new Date().toISOString(), notifId]);
            }
          }
        }
        for (const os of overdueSubtasks) {
          const daysOverdue = Math.floor((new Date(today) - new Date(os.deadline)) / 86400000);
          _fireOrResolve(db, {
            type: 'deadline_missed', client_id: r.client_id, service_id: r.service_id,
            subtask_id: os.id, period: r.current_period,
            message: `${r.service_name} — missed deadline: ${os.name} was due ${os.deadline} (${daysOverdue} day(s) overdue)`,
            conditionTrue: true,
          });
        }
      } catch (e) { console.error('[Alerts] deadline_missed error:', e.message); }

      // ── deadline_approaching / document_missing / docs_ready ────────────────
      // Only meaningful when a dated subtask is actively driving the cell —
      // matches the Compliance Overview's Branch 1. Fallback/all_done branches
      // (undated-only or fully complete) don't have a single subtask to alert
      // on, so no alert fires in those branches — consistent with there being
      // nothing actionable for the CA to do right now in that case.
      if (activeSubtask) {
        const alertDays = (activeSubtask.alert_days != null) ? activeSubtask.alert_days : (r.svc_alert_days || 3);
        const daysUntil = Math.ceil((new Date(activeSubtask.deadline) - new Date(today)) / 86400000);
        const isDeadlineAlert = daysUntil >= 0 && daysUntil <= alertDays;
        const docsExpected = activeSubtask.docsExpected;
        const docsReceived = activeSubtask.docsReceived;
        const docsMissing = docsExpected > 0 && docsReceived < docsExpected;
        const docsAllIn = docsExpected > 0 && docsReceived >= docsExpected && activeSubtask.status !== 'Done';

        _fireOrResolve(db, {
          type: 'deadline_approaching', client_id: r.client_id, service_id: r.service_id,
          subtask_id: activeSubtask.id, period: r.current_period,
          message: `${r.service_name} — ${activeSubtask.name} due ${activeSubtask.deadline} (${daysUntil} day(s))`,
          conditionTrue: isDeadlineAlert,
        });

        _fireOrResolve(db, {
          type: 'document_missing', client_id: r.client_id, service_id: r.service_id,
          subtask_id: activeSubtask.id, period: r.current_period,
          message: `${r.service_name} — ${docsExpected - docsReceived} document(s) missing for ${activeSubtask.name}`,
          conditionTrue: docsMissing,
        });

        _fireOrResolve(db, {
          type: 'docs_ready', client_id: r.client_id, service_id: r.service_id,
          subtask_id: activeSubtask.id, period: r.current_period,
          message: `${r.service_name} — all documents collected for ${activeSubtask.name}. Tap to mark done.`,
          conditionTrue: docsAllIn,
        });
      }
    }
  } catch (err) {
    console.error('[Alerts] Alert engine error:', err.message);
  }
}


// ── Auto-resolve stale threads (Option 1 — time-based) ───────────────────────
// Runs on every AI loop cycle (every 30 seconds).
// Finds open threads where no message has arrived for auto_resolve_days.
// Closes them silently and generates a timeline entry for each.

async function autoResolveStaleThreads(db) {
  try {
    let autoResolveDays = 5;
    try {
      const sr = db.exec(`SELECT value FROM settings WHERE key = 'auto_resolve_days'`);
      if (sr.length && sr[0].values.length && sr[0].values[0][0]) {
        autoResolveDays = parseInt(sr[0].values[0][0]) || 5;
      }
    } catch (e) {}

    const cutoff = new Date(Date.now() - autoResolveDays * 24 * 60 * 60 * 1000).toISOString();

    // Find all open threads that have gone silent beyond the threshold
    const stale = db.exec(`
      SELECT id, client_id, service_tag, running_summary
      FROM conversations
      WHERE status = 'open' AND last_message_at < ?
    `, [cutoff]);

    if (!stale.length || !stale[0].values.length) return;

    const now = new Date().toISOString();
    for (const [convId, clientId, serviceTag, runningSummary] of stale[0].values) {
      // Close the thread
      db.run(`
        UPDATE conversations
        SET status = 'resolved', resolved_at = ?, resolved_reason = 'auto_timer'
        WHERE id = ?
      `, [now, convId]);

      // Timeline entry so CA can see it in the client profile
      const content = `Conversation closed automatically — no activity for ${autoResolveDays} days${runningSummary ? ': ' + runningSummary : ''}`;
      db.run(`
        INSERT INTO timeline (client_id, entry_type, content, entry_date, service_name, created_at)
        VALUES (?, 'system', ?, ?, ?, ?)
      `, [clientId, content, now, serviceTag || null, now]);

      console.log(`[AI] Auto-resolved stale thread #${convId} (no activity for ${autoResolveDays} days)`);
    }

    if (stale[0].values.length > 0) saveDatabase();

  } catch (err) {
    console.error('[AI] Auto-resolve sweep error:', err.message);
  }
}


// ── Status helper (used by GET /api/ai/status) ────────────────────────────────

function getStatus() {
  const db = getDb();
  let pending = 0;
  try {
    const r = db.exec(`
      SELECT COUNT(*) FROM messages
      WHERE processed = 0 AND (direction = 'incoming' OR direction IS NULL)
    `);
    if (r.length) pending = r[0].values[0][0];
  } catch (e) {}
  return { processing: aiProcessing, pending, processedTotal: aiProcessedCount, lastRun: aiLastRun };
}

module.exports = { processMessages, getStatus, runAlertEngine };
