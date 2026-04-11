#!/usr/bin/env node
// One-shot VAPID keypair generator. Run once at deploy time, then store the
// resulting JSON in GCP Secret Manager (or set SKYBASE_VAPID_JSON locally
// for dev). Rotating these keys invalidates every existing push subscription
// — treat them as immutable post-launch.
//
//   node scripts/gen-vapid.mjs --subject mailto:you@example.com > vapid.json

import webpush from "web-push";

const args = process.argv.slice(2);
let subject = "mailto:admin@example.com";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--subject" && i + 1 < args.length) {
    subject = args[i + 1];
    i++;
  }
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(
  JSON.stringify({ publicKey, privateKey, subject }, null, 2) + "\n",
);
