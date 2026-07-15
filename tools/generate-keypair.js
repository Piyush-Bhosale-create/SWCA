// tools/generate-keypair.js
//
// RUN THIS ONCE, ON YOUR OWN COMPUTER — NOT ON A CLIENT'S MACHINE.
//
// Creates your personal "signing stamp": a private key (keep this secret,
// forever — never send it, never upload it, never commit it to any repo)
// and a public key (safe to embed inside the app itself, since it can only
// CHECK a signature, not CREATE one).
//
// Usage:
//   node tools/generate-keypair.js
//
// Output:
//   license-keys/private.pem   — your secret signing key. BACK THIS UP
//                                 somewhere safe (e.g. a password manager
//                                 or encrypted drive). If you lose it, you
//                                 cannot issue or renew any future license
//                                 without generating a brand new key pair
//                                 (which would also require updating every
//                                 existing client's copy of src/license.js).
//   license-keys/public.pem    — safe to view/share. You'll paste the
//                                 contents of this into src/license.js once.

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const outDir = path.join(__dirname, '..', 'license-keys');

if (fs.existsSync(path.join(outDir, 'private.pem'))) {
  console.log('\n⚠️  A key pair already exists at license-keys/.');
  console.log('   Generating a new one would make every license you already');
  console.log('   issued stop working. Delete the folder first only if you');
  console.log('   are certain you want to start over.\n');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'private.pem'),
  privateKey.export({ type: 'pkcs8', format: 'pem' })
);
fs.writeFileSync(
  path.join(outDir, 'public.pem'),
  publicKey.export({ type: 'spki', format: 'pem' })
);

console.log('\n✅  Key pair created in license-keys/\n');
console.log('NEXT STEPS:');
console.log('1. Open license-keys/public.pem and copy its full contents.');
console.log('2. Paste it into src/license.js, replacing the PUBLIC_KEY_PEM placeholder.');
console.log('3. Keep license-keys/private.pem somewhere safe and backed up.');
console.log('   Never copy it into a client\'s installation folder.\n');
