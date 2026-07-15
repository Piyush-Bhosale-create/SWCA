// ai/external.js
// SW.CA1 — External AI provider calls for Pass 2 (Milestone 9.5)
// Handles Groq, Gemini, and OpenAI. Returns null on any failure → processor falls back to Ollama.

const fetch = require('node-fetch');

const PROVIDERS = {
  'groq-llama-3.1-8b':  { type: 'openai-compat', url: 'https://api.groq.com/openai/v1/chat/completions',          model: 'llama-3.1-8b-instant'    },
  'groq-llama-3.3-70b': { type: 'openai-compat', url: 'https://api.groq.com/openai/v1/chat/completions',          model: 'llama-3.3-70b-versatile'  },
  'gemini-flash':        { type: 'gemini',        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', model: 'gemini-2.0-flash' },
  'openai-gpt4.1-nano':  { type: 'openai-compat', url: 'https://api.openai.com/v1/chat/completions',               model: 'gpt-4.1-nano'             },
};

// ── Main export ───────────────────────────────────────────────────────────────
// Returns { summary, service_name } on success, null on any failure.

async function callExternal(prompt, provider, apiKey) {
  if (!provider || provider === 'local' || !apiKey) return null;

  const cfg = PROVIDERS[provider];
  if (!cfg) {
    console.error(`[AI] External: unknown provider "${provider}"`);
    return null;
  }

  try {
    let rawText = '';

    if (cfg.type === 'openai-compat') {
      const response = await fetch(cfg.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify({
          model:       cfg.model,
          messages:    [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens:  200,
        }),
        timeout: 20000,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} — ${errText.substring(0, 120)}`);
      }
      const data = await response.json();
      rawText = data.choices?.[0]?.message?.content || '';

    } else if (cfg.type === 'gemini') {
      const response = await fetch(`${cfg.url}?key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          contents:       [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
        }),
        timeout: 20000,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} — ${errText.substring(0, 120)}`);
      }
      const data = await response.json();
      rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    return parseResponse(rawText);

  } catch (e) {
    console.error(`[AI] External (${provider}) failed — falling back to Ollama:`, e.message);
    return null;
  }
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseResponse(text) {
  const clean = text.replace(/```json\n?|\n?```/g, '').trim();
  let parsed = {};
  try { parsed = JSON.parse(clean); }
  catch (e) {
    const m = clean.match(/\{[\s\S]*?\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch (e2) {}
  }
  return {
    summary:      typeof parsed.summary === 'string'                          ? parsed.summary.substring(0, 200)      : null,
    service_name: parsed.service_name && parsed.service_name !== 'null'       ? String(parsed.service_name).substring(0, 50) : null,
  };
}

module.exports = { callExternal };
