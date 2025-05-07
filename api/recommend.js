// api/recommend.js

import admin from 'firebase-admin';
import OpenAI from 'openai';

// ————— In‐memory cache (5 min TTL) —————
let cache = { itemsByType: {}, lastFetch: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchItems(type) {
  const now = Date.now();
  if (cache.itemsByType[type] && (now - cache.lastFetch) < CACHE_TTL) {
    console.log(`🗄️  cache hit for "${type}" (${now - cache.lastFetch} ms old)`);
    return cache.itemsByType[type];
  }
  console.log(`🗄️  cache miss for "${type}", reading RTDB…`);
  const snap = await admin.database().ref(type).once('value');
  const arr = [];
  snap.forEach(child => {
    const d = child.val();
    if (Array.isArray(d.embedding)) {
      arr.push({ id: child.key, embedding: d.embedding });
    }
  });
  cache = {
    itemsByType: { ...cache.itemsByType, [type]: arr },
    lastFetch: now
  };
  console.log(`🗄️  cached ${arr.length} embeddings for "${type}"`);
  return arr;
}

// ————— Initialize Firebase Admin SDK —————
if (!admin.apps.length) {
  console.log('🔧 Initializing Firebase Admin');
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:   process.env.FIREBASE_DB_URL
  });
}

// ————— Initialize OpenAI client —————
console.log('🔧 Initializing OpenAI client');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export default async function handler(req, res) {
  const start = Date.now();
  console.log('🔔 handler start');

  // 1) Method check
  if (req.method !== 'GET') {
    console.log('🚫 wrong method:', req.method);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // 2) Auth header
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    console.log('🚫 missing or malformed bearer token');
    return res.status(401).json({ error: 'Missing Bearer token' });
  }
  const idToken = authHeader.slice(7).trim();

  // 3) Verify Firebase ID token
  let uid;
  try {
    console.log('⏳ verifying token');
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
    console.log('✅ token verified for uid=', uid);
  } catch (err) {
    console.error('❌ token verification failed', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  console.log('⏱️ after auth:', Date.now() - start, 'ms');

  // 4) Validate query type
  const type = req.query.type;
  if (!['pets', 'articles'].includes(type)) {
    console.log('🚫 invalid type param:', type);
    return res.status(400).json({ error: 'Invalid type; must be "pets" or "articles"' });
  }
  console.log('📦 request for type=', type);

  try {
    // 5) Load the user's explicit preferences
    const prefSnap = await admin
      .database()
      .ref(`users/${uid}/preferences`)
      .once('value');
    const userPrefs = prefSnap.val() || {};
    console.log('🔧 user prefs:', userPrefs);

    // 6) Fetch embeddings (with cache)
    const tDB = Date.now();
    const items = await fetchItems(type);
    console.log('⏱️ DB+parse:', Date.now() - tDB, 'ms');
    console.log('🔢 items count:', items.length);

    // 7) Build a custom prompt from prefs
    let prompt = `Recommend me 5 ${type}`;
    if (type === 'pets'
      && Array.isArray(userPrefs.pets)
      && userPrefs.pets.length) {
      prompt += ` (species: ${userPrefs.pets.join(', ')})`;
    }
    if (type === 'articles'
      && Array.isArray(userPrefs.articles)
      && userPrefs.articles.length) {
      prompt += ` (topics: ${userPrefs.articles.join(', ')})`;
    }

    // 8) Generate query embedding
    const tAI = Date.now();
    console.log('⏳ calling OpenAI:', prompt);
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: [prompt]
    });
    const qEmb = embRes.data[0].embedding;
    console.log('⏱️ openai:', Date.now() - tAI, 'ms');
    console.log('✅ query embedding length=', qEmb.length);

    // 9) Cosine similarity & top‐5
    const tSim = Date.now();
    console.log('⏳ scoring', items.length, 'items…');
    const cosine = (a, b) => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1e-12);
    };

    const recommendations = items
      .map(item => ({ id: item.id, score: cosine(qEmb, item.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(x => x.id);
    console.log('⏱️ scoring:', Date.now() - tSim, 'ms');
    console.log('✅ recommendations:', recommendations);

    console.log('⏱️ total handler:', Date.now() - start, 'ms');
    return res.status(200).json({ recommendations });

  } catch (err) {
    console.error('❌ error in handler:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
