// src/license.js
// SW.CA1 — License verification
// Stage 1: signed file + expiry (offline, always the ceiling on access)
// Stage 2: optional remote early-revoke check (src/licenseRemote.js)
//
// PLAIN-ENGLISH SUMMARY:
// Every install has a small file (license.json) that says who it's licensed
// to and until when. That file is digitally "stamped" — sealed with a
// signature that only the developer's private key can produce. This module
// checks that stamp is genuine and checks the date. It never edits or
// creates that file itself — it only reads and verifies it.
//
// If the license is missing, tampered with, or expired, the app does NOT
// shut down or delete anything. It keeps all existing data fully viewable
// and exportable, but pauses new AI processing, deadline tracking, and
// alerts, so no new value is created until the license is renewed. See
// isRestricted() / getLicenseStatus().
//
// Stage 2 adds an optional remote check (src/licenseRemote.js) that can
// restrict access EARLY, before the local expiry date, if the developer
// marks this firm as revoked. It can never do the opposite — it can't
// grant access beyond what the signed license.json itself allows. That
// file is always the ceiling; the remote check can only lower it early.

const fs     = require('fs');
const crypto = require('crypto');
const remote = require('./licenseRemote');

// ── Your public key goes here ──────────────────────────────────────────────
// This is safe to be visible in the code — a public key can only CHECK a
// signature, never CREATE one. Replace this placeholder with the contents
// of license-keys/public.pem after running tools/generate-keypair.js once.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASirJAiB3WBlgNXrgZidkZpY+DzyY7djYip1ourp3lM4=
-----END PUBLIC KEY-----`;

// How many days before real expiry to start showing a "renewing soon"
// notice, so a firm's access is never a surprise.
const WARNING_WINDOW_DAYS = 7;

let cachedStatus  = null; // set by checkLicense(), read by getLicenseStatus()
let cachedContact = null; // remembered so remote-revoke messages can reuse it

// Rebuilds the exact same text that was originally signed, so we can check
// the signature against it. Field order must be stable (sorted) or a
// perfectly valid license would wrongly fail verification.
function canonicalPayload(license) {
  const { signature, ...rest } = license;
  const sorted = {};
  Object.keys(rest).sort().forEach(k => { sorted[k] = rest[k]; });
  return JSON.stringify(sorted);
}

function verifySignature(license) {
  try {
    const publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);
    const payload   = Buffer.from(canonicalPayload(license), 'utf8');
    const signature = Buffer.from(license.signature, 'base64');
    // `null` as the algorithm is correct/required for Ed25519 in Node's crypto.
    return crypto.verify(null, payload, publicKey, signature);
  } catch (err) {
    return false;
  }
}

function daysBetween(fromDate, toDate) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.ceil((toDate.getTime() - fromDate.getTime()) / MS_PER_DAY);
}

/**
 * Reads and verifies the license file at `licensePath`.
 * Returns a status object and also caches it for getLicenseStatus().
 *
 * status.restricted === true means: pause new AI processing / alerts,
 * but keep all existing data readable and exportable (see server.js).
 */
function checkLicense(licensePath, supportContact) {
  const contact = supportContact || 'your SW.CA1 provider';
  cachedContact = contact;
  let raw;

  try {
    raw = fs.readFileSync(licensePath, 'utf8');
  } catch (err) {
    cachedStatus = {
      valid: false,
      restricted: true,
      reason: 'missing',
      message: `No license file found. Contact ${contact} to activate this installation.`,
    };
    return cachedStatus;
  }

  let license;
  try {
    license = JSON.parse(raw);
  } catch (err) {
    cachedStatus = {
      valid: false,
      restricted: true,
      reason: 'corrupt',
      message: `The license file could not be read. Contact ${contact} for a fresh copy.`,
    };
    return cachedStatus;
  }

  if (!license.signature || !license.expires_at || !license.firm_name) {
    cachedStatus = {
      valid: false,
      restricted: true,
      reason: 'invalid_format',
      message: `The license file is incomplete. Contact ${contact} for a fresh copy.`,
    };
    return cachedStatus;
  }

  if (!verifySignature(license)) {
    cachedStatus = {
      valid: false,
      restricted: true,
      reason: 'tampered',
      message: `The license file could not be verified as genuine. Contact ${contact}.`,
    };
    return cachedStatus;
  }

  const today     = new Date(new Date().toISOString().slice(0, 10)); // midnight UTC, date-only
  const expiresAt = new Date(license.expires_at);
  const daysLeft  = daysBetween(today, expiresAt);

  if (daysLeft < 0) {
    cachedStatus = {
      valid: false,
      restricted: true,
      reason: 'expired',
      firmName: license.firm_name,
      firmId: license.firm_id,
      expiresAt: license.expires_at,
      daysLeft,
      message: `Your SW.CA1 access period ended on ${license.expires_at}. New messages, alerts, and AI processing are paused. Your existing data remains fully viewable and exportable. Contact ${contact} to renew.`,
    };
    return cachedStatus;
  }

  if (daysLeft <= WARNING_WINDOW_DAYS) {
    cachedStatus = {
      valid: true,
      restricted: false,
      reason: 'expiring_soon',
      firmName: license.firm_name,
      firmId: license.firm_id,
      expiresAt: license.expires_at,
      daysLeft,
      message: `Your SW.CA1 access renews in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${license.expires_at}). Contact ${contact} if you have questions.`,
    };
    return cachedStatus;
  }

  cachedStatus = {
    valid: true,
    restricted: false,
    reason: 'active',
    firmName: license.firm_name,
    firmId: license.firm_id,
    expiresAt: license.expires_at,
    daysLeft,
    message: null,
  };
  return cachedStatus;
}

// Read-only accessor — used by routes/timers that need to know the current
// status without re-reading the file from disk every time.
//
// This is also where Stage 2's remote check gets folded in. The rule is
// one-directional: a confirmed remote "revoked" can turn an otherwise-valid
// local status into a restricted one, early. It can never do the reverse —
// a remote "active" (or an unreachable remote) never overrides an already
// expired/tampered/missing local license. The signed file is always the
// outer boundary; the remote check can only pull that boundary in sooner.
function getLicenseStatus() {
  const local = cachedStatus || {
    valid: false,
    restricted: true,
    reason: 'not_checked',
    message: 'License has not been checked yet.',
  };

  const remoteStatus = remote.getCachedRemoteStatus();
  if (remoteStatus.reached && remoteStatus.status === 'revoked' && local.valid) {
    const contact = cachedContact || 'your SW.CA1 provider';
    return {
      ...local,
      valid: false,
      restricted: true,
      reason: 'revoked_remote',
      message: `Access to this SW.CA1 installation has been paused. Contact ${contact} for details.`,
    };
  }

  return local;
}

function isRestricted() {
  return getLicenseStatus().restricted === true;
}

// The firm_id to check remotely — taken only from the verified, signed
// local license, never from config.json. This matters: if it were read
// from an editable config file instead, someone could point their own
// install at a *different* firm's "active" record to dodge a revoke.
// Binding it to the signature closes that off.
function getFirmId() {
  return (cachedStatus && cachedStatus.firmId) || null;
}

// Convenience wrapper so server.js only ever needs to require this one
// file, not src/licenseRemote.js directly.
async function refreshRemoteStatus(firebaseUrl) {
  const firmId = getFirmId();
  if (!firmId || !firebaseUrl) {
    return { reached: false, reason: 'not_configured' };
  }
  return remote.refreshRemoteStatus(firebaseUrl, firmId);
}

module.exports = {
  checkLicense,
  getLicenseStatus,
  isRestricted,
  getFirmId,
  refreshRemoteStatus,
  verifyLicenseObject: verifySignature, // same check checkLicense() already uses internally
};
