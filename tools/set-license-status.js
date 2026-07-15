// tools/set-license-status.js
//
// Sets (or creates) a firm's early-revoke status in Firebase — the Stage 2
// switch. This replaces editing it by hand in the Firebase console: your
// security rules deliberately block console/public writes to "licenses"
// (so a client's installation can never flip its own status back to
// "active"), so this tool uses the same admin credentials generate-license.js
// already uses, which are allowed to bypass that rule.
//
// Usage:
//   node tools/set-license-status.js "firm-id" active
//   node tools/set-license-status.js "firm-id" revoked
//
// The firm-id must exactly match the firm_id shown when you ran
// generate-license.js for that firm (also visible inside their license.json).

const fs   = require('fs');
const path = require('path');

const [firmId, statusArg] = process.argv.slice(2);

if (!firmId || !statusArg) {
  console.log('\nUsage: node tools/set-license-status.js "firm-id" <active|revoked>\n');
  process.exit(1);
}

const status = statusArg.toLowerCase();
if (status !== 'active' && status !== 'revoked') {
  console.log('\n❌  Status must be exactly "active" or "revoked" (got: "' + statusArg + '")\n');
  process.exit(1);
}

const serviceAccountPath = path.join(__dirname, '..', 'license-keys', 'firebase-service-account.json');
const dbConfigPath       = path.join(__dirname, '..', 'license-keys', 'firebase-config.json');

if (!fs.existsSync(serviceAccountPath) || !fs.existsSync(dbConfigPath)) {
  console.log('\n❌  Stage 3 admin credentials not found in license-keys/.');
  console.log('   This tool needs the same firebase-service-account.json and');
  console.log('   firebase-config.json used by generate-license.js — see');
  console.log('   SETUP-LICENSE-STAGE3.md if you haven\u2019t set those up yet.\n');
  process.exit(1);
}

(async () => {
  let initializeApp, getApps, cert, deleteApp, getDatabase;
  let firebaseApp, firebaseDb, serviceAccount, dbConfig;

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
    dbConfig       = JSON.parse(fs.readFileSync(dbConfigPath, 'utf8'));
  } catch (err) {
    console.log(`\n⚠️  Step "read Firebase config files" failed: ${err.message}\n`);
    return;
  }

  try {
    firebaseApp = getApps().length
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount), databaseURL: dbConfig.databaseURL });
    firebaseDb = getDatabase(firebaseApp);
  } catch (err) {
    console.log(`\n⚠️  Step "initialize Firebase admin app" failed: ${err.message}\n`);
    console.log(err.stack || err);
    return;
  }

  try {
    const writePromise = firebaseDb.ref(`licenses/${firmId}/status`).set(status);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out after 15 seconds.')), 15000)
    );
    await Promise.race([writePromise, timeoutPromise]);

    console.log(`\n✅  "${firmId}" is now set to: ${status}`);
    if (status === 'revoked') {
      console.log(`   Their installation will pick this up within its next check-in`);
      console.log(`   (up to ${dbConfig.remote_check_hours || 12} hours, usually sooner — it also checks shortly`);
      console.log(`   after their app starts).\n`);
    } else {
      console.log(`   Their installation will resume within its next check-in.\n`);
    }

    await deleteApp(firebaseApp);
  } catch (err) {
    console.log(`\n⚠️  Step "write status to Firebase" failed: ${err.message}\n`);
    console.log(err.stack || err);
    try { await deleteApp(firebaseApp); } catch (_) {}
    process.exit(1);
  }
})();
