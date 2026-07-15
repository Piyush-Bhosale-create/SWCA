// tools/generate-license.js
//
// RUN THIS ON YOUR OWN COMPUTER to create (or renew) a license for a client
// firm. It always creates a local license.json file (Stage 1 style — you
// can still copy this by hand if you want). If you've also set up the
// Stage 3 Firebase admin credentials (see SETUP-LICENSE-STAGE3.md), it
// additionally generates a short activation code the client can type into
// Settings instead — no file-copying needed at all.
//
// Usage:
//   node tools/generate-license.js "Firm Name" <days-valid> [output-path]
//
// Examples:
//   node tools/generate-license.js "Sharma & Associates" 30
//     → creates ./license.json, valid for 30 days from today,
//       and (if Stage 3 is set up) an activation code to hand them instead
//
//   node tools/generate-license.js "Sharma & Associates" 365 ./out/sharma-license.json
//     → creates a 1-year license at a custom path (handy when preparing
//       several clients' licenses at once, before visiting each firm)
//
// Renewing an existing client is the same command — just run it again with
// a new day count. If using activation codes, hand them the new code; if
// copying files by hand, replace their old license.json with the new one.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const [firmName, daysArg, outArg] = process.argv.slice(2);

if (!firmName || !daysArg) {
  console.log('\nUsage: node tools/generate-license.js "Firm Name" <days-valid> [output-path]\n');
  process.exit(1);
}

const days = parseInt(daysArg, 10);
if (isNaN(days) || days <= 0) {
  console.log('\n❌  <days-valid> must be a positive number, e.g. 30 or 365\n');
  process.exit(1);
}

const privateKeyPath = path.join(__dirname, '..', 'license-keys', 'private.pem');
if (!fs.existsSync(privateKeyPath)) {
  console.log('\n❌  No private key found at license-keys/private.pem');
  console.log('   Run: node tools/generate-keypair.js  first (one time only).\n');
  process.exit(1);
}

const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf8');
const privateKey    = crypto.createPrivateKey(privateKeyPem);

const today     = new Date();
const expiresAt = new Date(today);
expiresAt.setDate(expiresAt.getDate() + days);

const toISODate = (d) => d.toISOString().slice(0, 10);

// Everything except `signature` gets signed. Key order must match
// src/license.js's canonicalPayload() — both sort keys alphabetically,
// so this works automatically as long as neither file changes that rule.
const licenseFields = {
  expires_at: toISODate(expiresAt),
  firm_id:    firmName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  firm_name:  firmName,
  issued_at:  toISODate(today),
};

const sorted = {};
Object.keys(licenseFields).sort().forEach(k => { sorted[k] = licenseFields[k]; });
const payload = Buffer.from(JSON.stringify(sorted), 'utf8');

const signature = crypto.sign(null, payload, privateKey).toString('base64');

const licenseObject = { ...licenseFields, signature };

const outPath = outArg || path.join(process.cwd(), 'license.json');
fs.writeFileSync(outPath, JSON.stringify(licenseObject, null, 2));

console.log(`\n✅  License created for "${firmName}"`);
console.log(`   Valid until: ${licenseFields.expires_at} (${days} days from today)`);
console.log(`   Saved to:    ${outPath}`);

// Unambiguous alphabet — no 0/O, 1/I/L, to avoid mistyped codes.
function generateActivationCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let group = '';
    for (let i = 0; i < 4; i++) group += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(group);
  }
  return groups.join('-');
}

const serviceAccountPath = path.join(__dirname, '..', 'license-keys', 'firebase-service-account.json');
const dbConfigPath       = path.join(__dirname, '..', 'license-keys', 'firebase-config.json');

if (!fs.existsSync(serviceAccountPath) || !fs.existsSync(dbConfigPath)) {
  console.log(`\nNext step: copy license.json to the client's SW.CA1 folder (same folder`);
  console.log(`as their config.json), then restart the app.`);
  console.log(`\nTip: set up Stage 3 (see SETUP-LICENSE-STAGE3.md) once, and this tool will`);
  console.log(`generate a short activation code instead — no file-copying needed.\n`);
  process.exit(0);
}

(async () => {
  let firebaseApp, firebaseDb, serviceAccount, dbConfig;
  let initializeApp, getApps, cert, deleteApp, getDatabase;

  try {
    ({ initializeApp, getApps, cert, deleteApp } = require('firebase-admin/app'));
    ({ getDatabase } = require('firebase-admin/database'));
  } catch (err) {
    console.log(`\n⚠️  Step "load firebase-admin" failed: ${err.message}`);
    console.log(`   Try: npm install\n`);
    return;
  }

  try {
    serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  } catch (err) {
    console.log(`\n⚠️  Step "read/parse firebase-service-account.json" failed: ${err.message}`);
    console.log(`   Check the file is valid, unedited JSON straight from Firebase.\n`);
    return;
  }

  try {
    dbConfig = JSON.parse(fs.readFileSync(dbConfigPath, 'utf8'));
  } catch (err) {
    console.log(`\n⚠️  Step "read/parse firebase-config.json" failed: ${err.message}\n`);
    return;
  }

  try {
    firebaseApp = getApps().length
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount), databaseURL: dbConfig.databaseURL });
    firebaseDb = getDatabase(firebaseApp);
  } catch (err) {
    console.log(`\n⚠️  Step "initialize Firebase admin app" failed: ${err.message}`);
    console.log(`   This usually means the service account JSON's contents don't match`);
    console.log(`   what Firebase expects — try re-downloading it fresh from Firebase`);
    console.log(`   console → Project settings → Service accounts → Generate new private key.`);
    console.log(`\n   Full details, for troubleshooting:\n`);
    console.log(err.stack || err);
    console.log('');
    return;
  }

  try {
    const code = generateActivationCode();
    const writePromise = firebaseDb.ref(`activation_codes/${code}`).set({
      firm_id: licenseFields.firm_id,
      license: licenseObject,
      created_at: new Date().toISOString(),
    });
    // Also (re)set this firm's early-revoke switch to "active" — automatic,
    // so issuing a license never leaves the Stage 2 switch unset. This only
    // ever sets it to "active"; if you need to revoke someone, use
    // tools/set-license-status.js instead of running this command again.
    const licenseStatusPromise = firebaseDb.ref(`licenses/${licenseFields.firm_id}/status`).set('active');
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out after 15 seconds — Firebase never confirmed the write.')), 15000)
    );
    await Promise.race([Promise.all([writePromise, licenseStatusPromise]), timeoutPromise]);

    console.log(`\n📋  Activation code for "${firmName}":\n`);
    console.log(`   ${code}\n`);
    console.log(`Give this to the client. They enter it in Settings → License →`);
    console.log(`Activation Code, then click Activate. No file-copying needed.`);
    console.log(`(This code stops working after ${dbConfig.activation_code_max_age_days || 60} days —`);
    console.log(`generate a fresh one if it goes unused that long.)\n`);

    console.log(`This firm's Stage 2 early-revoke switch was also set to "active" automatically.`);
    console.log(`If you ever need to revoke this firm later, use:`);
    console.log(`   node tools/set-license-status.js "${licenseFields.firm_id}" revoked\n`);

    await deleteApp(firebaseApp);
  } catch (err) {
    console.log(`\n⚠️  Step "write activation code to Firebase" failed: ${err.message}`);
    console.log(`   This usually means your security rules don't allow this, or the`);
    console.log(`   database URL points somewhere the service account can't reach.`);
    console.log(`\n   Full details, for troubleshooting:\n`);
    console.log(err.stack || err);
    console.log('');
    console.log(`   The local license.json above was still created successfully — you can`);
    console.log(`   copy that file to the client by hand instead in the meantime.\n`);
    try { await deleteApp(firebaseApp); } catch (_) { /* best effort */ }
    process.exit(1); // don't let a lingering realtime connection hang the CLI
  }
})();
