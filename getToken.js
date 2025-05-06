// getToken.js
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccount.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function printToken(uid) {
  // This mints a *custom* token, not an ID token.
  // To exchange it for an ID token you'd normally sign in via the client SDK.
  const customToken = await admin.auth().createCustomToken(uid);
  console.log(customToken);
}

// Replace with a real user UID from your Realtime Database
printToken("PjegQmBfinNYwLxkhYte5qpGoO82").catch(console.error);
