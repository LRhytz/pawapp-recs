// api/recommend.js

import dotenv from 'dotenv'
dotenv.config()

import admin from 'firebase-admin'
import OpenAI from 'openai'

// ————— In-memory cache (5 min TTL) —————
let cache = { itemsByType: {}, lastFetch: 0 }
const CACHE_TTL = 5 * 60 * 1000

async function fetchItems(dbNode) {
  const now = Date.now()
  if (cache.itemsByType[dbNode] && now - cache.lastFetch < CACHE_TTL) {
    console.log(`🗄️ cache hit for "${dbNode}"`)
    return cache.itemsByType[dbNode]
  }
  console.log(`🗄️ cache miss for "${dbNode}", reading RTDB…`)
  const snap = await admin.database().ref(dbNode).once('value')
  const arr = []
  snap.forEach(child => {
    const d = child.val()
    if (Array.isArray(d.embedding)) {
      arr.push({ id: child.key, embedding: d.embedding })
    }
  })
  cache = {
    itemsByType: { ...cache.itemsByType, [dbNode]: arr },
    lastFetch: now
  }
  console.log(`🗄️ cached ${arr.length} embeddings for "${dbNode}"`)
  return arr
}

// ————— Initialize Firebase Admin —————
if (!admin.apps.length) {
  console.log('🔥 FIREBASE_DB_URL is:', process.env.FIREBASE_DB_URL)
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    databaseURL: process.env.FIREBASE_DB_URL
  })
}

// ————— Initialize OpenAI client —————
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

export default async function handler(req, res) {
  const t0 = Date.now()
  console.log('🔔 handler start')

  // 1) only GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  // 2) auth
  const h = req.headers.authorization || ''
  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Bearer token' })
  }
  const idToken = h.slice(7).trim()
  let uid
  try {
    const decoded = await admin.auth().verifyIdToken(idToken)
    uid = decoded.uid
  } catch (err) {
    console.error('❌ token verify failed', err)
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  // 3) type check
  const type = req.query.type
  if (!['pets', 'articles'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type; must be "pets" or "articles"' })
  }

  try {
    // 4) load user prefs
    const prefSnap = await admin
      .database()
      .ref(`users/${uid}/preferences`)
      .once('value')
    const userPrefs = prefSnap.val() || {}
    console.log('🔧 user prefs:', userPrefs)

    // 5) map "pets" → "adoptions" in your RTDB
    const dbNode = type === 'pets' ? 'adoptions' : type

    // 6) fetch & cache embeddings
    const items = await fetchItems(dbNode)

    // 7) build prompt
    let prompt = `Recommend me 5 ${type}`
    if (
      type === 'pets' &&
      Array.isArray(userPrefs.pets) &&
      userPrefs.pets.length
    ) {
      prompt += ` (species: ${userPrefs.pets.join(', ')})`
    }
    if (
      type === 'articles' &&
      Array.isArray(userPrefs.articles) &&
      userPrefs.articles.length
    ) {
      prompt += ` (topics: ${userPrefs.articles.join(', ')})`
    }

    // 8) get query embedding
    console.log('⏳ calling OpenAI:', prompt)
    const embRes = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: [prompt]
    })
    const qEmb = embRes.data[0].embedding

    // 9) cosine + top-5
    const cosine = (a, b) => {
      let dot = 0, magA = 0, magB = 0
      for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i]
        magA += a[i] * a[i]
        magB += b[i] * b[i]
      }
      return dot / (Math.sqrt(magA) * Math.sqrt(magB) || 1e-12)
    }
    const recs = items
      .map(it => ({ id: it.id, score: cosine(qEmb, it.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(x => x.id)

    console.log('✅ recommendations:', recs, `(took ${Date.now() - t0} ms)`)
    return res.status(200).json({ recommendations: recs })

  } catch (err) {
    console.error('❌ error in handler:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
