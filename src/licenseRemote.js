// src/licenseRemote.js
// SW.CA1 — License verification (Stage 2: remote early-revoke check)
//
// PLAIN-ENGLISH SUMMARY:
// This checks a small, free Firebase database every few hours to see if
// the developer has flagged this specific firm as "revoked" — meaning
// access should pause even though the locally-signed license.json hasn't
// expired yet. This is the ONLY thing this module can do: restrict early.
//
// It can NEVER grant more access than the signed license.json already
// allows — that file (verified in src/license.js) is always the ceiling.
// This module can only lower that ceiling early, never raise it.
//
// If the check can't reach Firebase (no internet, firm's firewall,
// Firebase itself down, etc.), nothing bad happens — it simply keeps
// relying on whatever it last successfully learned, and otherwise defers
// entirely to the local signed license. A connectivity problem is never,
// by itself, treated as a reason to restrict access.

const fetch = require('node-fetch');

const TIMEOUT_MS = 8000;

// Holds the last successfully-confirmed remote result. A FAILED check
// never overwrites this — that's what keeps a temporary internet drop
// from being treated as a revoke.
let cachedRemote = { reached: false, reason: 'not_checked_yet' };

async function checkRemote(firebaseUrl, firmId) {
  if (!firebaseUrl || !firmId) {
    return { reached: false, reason: 'not_configured' };
  }

  const url = `${firebaseUrl.replace(/\/$/, '')}/licenses/${encodeURIComponent(firmId)}.json`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutHandle);

    if (!res.ok) {
      return { reached: false, reason: `http_${res.status}`, checkedAt: new Date().toISOString() };
    }

    const data = await res.json();
    if (!data || typeof data.status !== 'string') {
      // Nothing set up yet for this firm, or an unexpected shape.
      // Treat as "not reached" — never restrict on ambiguous data.
      return { reached: false, reason: 'no_data', checkedAt: new Date().toISOString() };
    }

    return {
      reached: true,
      status: data.status, // expected: 'active' or 'revoked'
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return { reached: false, reason: 'network_error', checkedAt: new Date().toISOString() };
  }
}

/**
 * Runs a check and updates the cache — but ONLY on a successful reach.
 * A failed attempt is reported back to the caller (useful for logging)
 * but deliberately does not touch the cache, so the last known-good
 * result keeps standing until a new one actually arrives.
 */
async function refreshRemoteStatus(firebaseUrl, firmId) {
  const result = await checkRemote(firebaseUrl, firmId);
  if (result.reached) {
    cachedRemote = result;
  }
  return result;
}

function getCachedRemoteStatus() {
  return cachedRemote;
}

module.exports = { refreshRemoteStatus, getCachedRemoteStatus, checkRemote };
