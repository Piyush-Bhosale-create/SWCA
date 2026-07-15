// src/licenseActivate.js
// SW.CA1 — License verification (Stage 3: activation-code redemption)
//
// PLAIN-ENGLISH SUMMARY:
// Instead of someone manually copying a license.json file onto this
// computer, the CA firm can type a short code into Settings. This module
// takes that code, looks up the real signed license behind it (stored in
// Firebase by the developer's own tool — see tools/generate-license.js),
// checks it's genuine using the exact same signature check as everywhere
// else in this app, and — only if that check passes — saves it as the
// real license.json file, exactly as if it had been copied in by hand.
//
// This module never talks to Firebase with any special permission. It
// only ever reads a single, narrow, already-public path — the same kind
// of read the license-status check (src/licenseRemote.js) already does.
// It has no ability to write to Firebase, list other firms' codes, or
// change anything remotely. The one thing it writes is a file on this
// computer's own disk.

const fs     = require('fs');
const fetch  = require('node-fetch');
const license = require('./license');

const TIMEOUT_MS = 8000;
const DEFAULT_MAX_AGE_DAYS = 60; // how long an activation code stays usable

async function activateWithCode(code, opts) {
  const { firebaseUrl, licensePath, supportContact, maxAgeDays } = opts || {};
  const cleanCode = (code || '').trim().toUpperCase();

  if (!cleanCode) {
    return { success: false, reason: 'empty_code', message: 'Please enter your activation code.' };
  }
  if (!firebaseUrl) {
    return {
      success: false,
      reason: 'not_configured',
      message: 'Activation isn\u2019t set up on this installation yet. Contact your provider.',
    };
  }

  const url = `${firebaseUrl.replace(/\/$/, '')}/activation_codes/${encodeURIComponent(cleanCode)}.json`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let entry;

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutHandle);
    if (!res.ok) {
      return {
        success: false,
        reason: 'network_error',
        message: 'Could not reach the activation service. Check your internet connection and try again.',
      };
    }
    entry = await res.json();
  } catch (err) {
    clearTimeout(timeoutHandle);
    return {
      success: false,
      reason: 'network_error',
      message: 'Could not reach the activation service. Check your internet connection and try again.',
    };
  }

  if (!entry || !entry.license) {
    return {
      success: false,
      reason: 'invalid_code',
      message: 'That code wasn\u2019t recognized. Double-check it, or contact your provider for a new one.',
    };
  }

  const maxAge = maxAgeDays || DEFAULT_MAX_AGE_DAYS;
  if (entry.created_at) {
    const ageDays = (Date.now() - new Date(entry.created_at).getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > maxAge) {
      return {
        success: false,
        reason: 'code_expired',
        message: 'This activation code has expired. Contact your provider for a new one.',
      };
    }
  }

  // Verify BEFORE writing anything to disk — a bad or corrupted response
  // must never overwrite a perfectly good, already-working license.json.
  if (!license.verifyLicenseObject(entry.license)) {
    return {
      success: false,
      reason: 'tampered',
      message: 'This code\u2019s license data could not be verified as genuine. Contact your provider.',
    };
  }

  try {
    fs.writeFileSync(licensePath, JSON.stringify(entry.license));
  } catch (err) {
    return {
      success: false,
      reason: 'write_failed',
      message: 'Could not save the license on this computer. Check folder permissions and try again.',
    };
  }

  // Re-run the normal, already-tested verification path on what we just
  // wrote, so the app's status immediately reflects reality — no restart
  // needed.
  const status = license.checkLicense(licensePath, supportContact);
  return { success: true, status };
}

module.exports = { activateWithCode };
