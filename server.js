// server.js (Outfitted) — unified userId handling, robust image mapping, closet scope, dual response shape
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { v4 as uuidv4 } from 'uuid';
import Airtable from 'airtable';
import { z } from 'zod';
import OpenAI from 'openai';
import crypto from 'crypto'; // Cloudinary signature

// ---------- PROCESS SAFETY ----------
process.on('unhandledRejection', (err) => { console.error('UNHANDLED_REJECTION', err); });
process.on('uncaughtException', (err) => { console.error('UNCAUGHT_EXCEPTION', err); process.exit(1); });

// ---------- ENV ----------
const {
  PORT = 10000,
  NODE_ENV,
  LOG_LEVEL = 'info',
  RAPIDAPI_KEY,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_CLOSET = 'Clothing Items',
  AIRTABLE_TABLE_OUTFITS = 'Outfits',
  AIRTABLE_TABLE_ORDERS = 'Orders',
  AIRTABLE_TABLE_LISTINGS = 'Listings',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  API_KEY,
  ALLOWED_ORIGINS = '',

  // Clothing Items fields
  CLOSET_NAME_FIELD = 'Item Name',
  CLOSET_CATEGORY_FIELD = 'Category',
  CLOSET_BRAND_FIELD = 'Brand',
  CLOSET_COLOR_FIELD = 'Color',
  CLOSET_PHOTO_FIELD = 'Photo',               // attachment or url
  CLOSET_PHOTO_AS_ATTACHMENT = 'true',
  CLOSET_USER_FIELD = 'User Id',              // single line text

  // Outfits fields
  OUTFITS_NAME_FIELD = 'Title',
  OUTFITS_ITEMS_FIELD = 'Items',              // linked to "Clothing Items"
  OUTFITS_PHOTO_FIELD = 'Photo',
  OUTFITS_STATUS_FIELD = 'Status',
  OUTFITS_REASON_FIELD = 'AI Reasoning',
  OUTFITS_PALETTE_FIELD = 'Palette',
  OUTFITS_OCCASION_FIELD = 'Occasion',
  OUTFITS_STYLE_FIELD = 'Style',
  OUTFITS_WEATHER_FIELD = 'Weather',
  OUTFITS_PHOTO_AS_ATTACHMENT = 'true',
  OUTFITS_USER_FIELD = 'User Id',             // single line text

  // Optional: bypass OpenAI for debugging
  SKIP_OPENAI = 'false',

  // Cloudinary
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_FOLDER = 'outfitted'
} = process.env;

// --- eBay OAuth token state (auto-refreshed, never hardcoded) ---
let ebayAccessToken  = '';
let tokenExpiresAt   = 0; // Unix ms — token is considered expired when Date.now() >= this

async function refreshEbayToken() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const certId   = process.env.EBAY_CERT_ID;
  if (!clientId || !certId) {
    throw new Error('EBAY_CLIENT_ID or EBAY_CERT_ID env vars not set');
  }
  console.log('[eBay] Refreshing access token — clientId present:', !!clientId, 'certId present:', !!certId);
  const credentials = Buffer.from(`${clientId}:${certId}`).toString('base64');
  const res  = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  const text = await res.text();
  console.log('[eBay] Token refresh response status:', res.status, '| body preview:', text.slice(0, 200));
  if (!res.ok) throw new Error(`eBay token refresh failed: ${res.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  ebayAccessToken = data.access_token;
  // Expire 5 minutes before the real expiry to give requests a buffer
  tokenExpiresAt  = Date.now() + (data.expires_in - 300) * 1000;
  console.log('[eBay] Token refreshed successfully, expires at:', new Date(tokenExpiresAt).toISOString());
}

// --- User scoping ---
const USER_ID_FIELD = 'User Id'; // the column name actually used in Airtable

// Unified user id helper (header → query → body). Returns null if missing.
const getUserId = (req) => {
  const v = req.header('x-user-id') ?? req.query.userId ?? req.body?.userId ?? '';
  const id = String(v).trim();
  return id || null;
};
// For write ops, require a user id
const requireUserId = (req) => {
  const uid = getUserId(req);
  if (!uid) {
    const err = new Error('Missing x-user-id');
    err.status = 400;
    err.code = 'NO_USER_ID';
    throw err;
  }
  return uid;
};

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) { console.error('⚠️ Missing Airtable creds'); process.exit(1); }
if (!OPENAI_API_KEY && String(SKIP_OPENAI).toLowerCase() !== 'true') { console.error('⚠️ Missing OPENAI_API_KEY'); process.exit(1); }
if (!API_KEY) { console.error('⚠️ Missing API_KEY'); process.exit(1); }

const CLOSET_PHOTO_IS_ATTACHMENT  = String(CLOSET_PHOTO_AS_ATTACHMENT).toLowerCase() === 'true';
const OUTFITS_PHOTO_IS_ATTACHMENT = String(OUTFITS_PHOTO_AS_ATTACHMENT).toLowerCase() === 'true';

// ---------- CORE ----------
const app = express();
app.set('trust proxy', 1);

const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes(origin) || origin?.startsWith('exp://')) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
}));
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false }));

const logger = pinoHttp({
  level: LOG_LEVEL,
  genReqId: (req) => req.headers['x-request-id'] || uuidv4(),
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers'],
});
app.use(logger);

const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ---------- AUTH ----------
function requireApiKey(req, res, next) {
  if (req.header('x-api-key') !== API_KEY) {
    req.log.warn({ msg: 'Unauthorized', path: req.path });
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
  }
  next();
}

// ---------- CLIENTS ----------
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const tbCloset   = base(AIRTABLE_TABLE_CLOSET);
const tbOutfits  = base(AIRTABLE_TABLE_OUTFITS);
const tbOrders   = base(AIRTABLE_TABLE_ORDERS);
const tbListings = base(AIRTABLE_TABLE_LISTINGS);
const openai    = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- UTILS ----------
const esc = (s = '') => String(s).replace(/'/g, "\\'");
const readField = (obj, key, fallbacks = []) => {
  if (obj[key] != null) return obj[key];
  for (const fb of fallbacks) if (obj[fb] != null) return obj[fb];
  return undefined;
};

// Prefer Airtable large thumbnail → raw url → string url
function firstUrl(val) {
  if (Array.isArray(val) && val[0]) {
    const a = val[0];
    return (a?.thumbnails?.large?.url) || a?.url;
  }
  if (typeof val === 'string' && /^https?:\/\//i.test(val)) return val;
  return undefined;
}

async function fetchClosetItemsByIds(ids = []) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const formula = `OR(${batch.map(id => `RECORD_ID() = '${esc(id)}'`).join(', ')})`;
    const page = await tbCloset.select({ filterByFormula: formula }).all();
    out.push(...page.map(r => ({ id: r.id, fields: r.fields })));
  }
  return out;
}

// --- Robust photo readers/writers ---
const PHOTO_FIELD_CANDIDATES = [
  CLOSET_PHOTO_FIELD,
  'Photo', 'Photos',
  'Image', 'Images',
  'Image URL', 'Image Url', 'Photo URL',
  'Picture', 'Pictures'
];

function readPhotoFromFields(fields) {
  for (const key of PHOTO_FIELD_CANDIDATES) {
    if (!key) continue;
    const val = readField(fields, key, []);
    const url = firstUrl(val);
    if (url) return url;
  }
  return undefined;
}

// ---------- SCHEMAS ----------
const OutfitSuggestSchema = z.object({
  userId: z.string().optional(),
  occasion: z.string().min(1),
  weather: z.string().optional(),
  style: z.string().optional(),
  itemIds: z.array(z.string()).nonempty('Provide itemIds from Clothing Items'),
  topK: z.number().int().min(1).max(5).default(1)
});
const SaveOutfitSchema = z.object({
  title: z.string().min(1),
  itemIds: z.array(z.string()).min(1),
  occasion: z.string().optional(),
  style: z.string().optional(),
  weather: z.string().optional(),
  reasoning: z.string().optional(),
  palette: z.array(z.string()).optional(),
  photoUrl: z.string().url().optional()
});
const CreateClosetItemSchema = z.object({
  name: z.string().min(1),
  category: z.string().min(1),
  color: z.string().optional(),
  brand: z.string().optional(),
  imageUrl: z.string().url().optional()
});
const UpdateClosetItemSchema = z.object({
  name: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  color: z.string().optional().nullable(),
  brand: z.string().optional().nullable(),
  imageUrl: z.string().url().optional().nullable()
});
const DescribeSchema = z.object({
  imageUrl: z.string().url()
});

// ---------- OPENAI ----------
async function generateOutfitsWithAI({ items, occasion, weather, style, topK }) {
  if (String(SKIP_OPENAI).toLowerCase() === 'true') {
    return [{
      name: `${style || 'Look'} for ${occasion}`,
      items: items.map(i => i.id),
      reasoning: 'Debug: SKIP_OPENAI enabled.',
      palette: ['neutral'],
      preview: ''
    }];
  }

  const system = `You are a fashion stylist AI. Return ONLY valid JSON:
{"outfits":[{"name":"string","items":["string"],"reasoning":"string","palette":["string"],"preview":""}]}`;

  const user = {
    occasion, weather: weather || '', style: style || '',
    items: items.map(i => ({
      id: i.id,
      name: readField(i.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']) || 'Unknown',
      category: readField(i.fields, CLOSET_CATEGORY_FIELD, ['Category']) || '',
      color: readField(i.fields, CLOSET_COLOR_FIELD, ['Color','Colors']) || '',
      brand: readField(i.fields, CLOSET_BRAND_FIELD, ['Brand']) || '',
      photo: readPhotoFromFields(i.fields)
    })),
    count: topK
  };

  const prompt = `Make ${topK} outfit suggestion(s) from these closet items for the given occasion.
Return ONLY JSON. No prose.

Input:
${JSON.stringify(user, null, 2)}
`;

  const extractJson = (s) => {
    if (!s) return null;
    s = s.replace(/```json|```/g, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a === -1 || b === -1) return null;
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  };

  try {
    const r = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        { role: 'system', content: system },
        { role: 'user',  content: prompt }
      ]
    });
    const text =
      r.output_text ||
      (Array.isArray(r.output) ? r.output.flatMap(o => (o?.content || []).map(c => c?.text || '')).join('') : '') ||
      '';
    const parsed = extractJson(text);
    if (!parsed) throw Object.assign(new Error('AI_JSON_PARSE_ERROR'), { status: 502, details: text?.slice?.(0, 400) });
    if (!parsed.outfits?.length) throw Object.assign(new Error('AI_EMPTY_OUTFITS'), { status: 502 });
    return parsed.outfits;
  } catch (e1) {
    try {
      const resp = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: prompt }
        ]
      });
      const content = resp.choices?.[0]?.message?.content || '';
      const parsed  = extractJson(content);
      if (!parsed) throw Object.assign(new Error('AI_JSON_PARSE_ERROR'), { status: 502, details: content?.slice?.(0, 400) });
      if (!parsed.outfits?.length) throw Object.assign(new Error('AI_EMPTY_OUTFITS'), { status: 502 });
      return parsed.outfits;
    } catch (e2) {
      const msg = e2?.response?.data?.error?.message || e2.message || 'OpenAI error';
      const status = e2?.status || e2?.response?.status || 502;
      throw Object.assign(new Error(`OPENAI_ERROR: ${msg}`), { status, details: e2?.response?.data });
    }
  }
}

async function describeImage({ imageUrl }) {
  if (String(SKIP_OPENAI).toLowerCase() === 'true') {
    return { name: 'Basic item', category: 'tee', color: 'white', brand: '' };
  }
  const prompt = `
Return ONLY JSON with keys: name, category, color, brand.
Category must be simple like "tee", "jeans", "shoes", "jacket", "hat", "bag".
Example:
{"name":"White tee","category":"tee","color":"white","brand":""}
`.trim();

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'You label clothing items. Only return compact JSON.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }
    ]
  });

  const text = resp.choices?.[0]?.message?.content?.trim?.() || '{}';
  const jsonStr = text.replace(/```json|```/g, '');
  try { return JSON.parse(jsonStr); } catch { return { name: '', category: '', color: '', brand: '' }; }
}

// ---------- DEBUG (non-prod) ----------
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/debug/routes', requireApiKey, (req, res) => {
    const routes = [];
    (app._router?.stack || []).forEach((m) => {
      if (m.route?.path) routes.push({ method: Object.keys(m.route.methods || {})[0], path: m.route.path });
    });
    res.json({ routes });
  });

  app.get('/api/debug/config', requireApiKey, (req, res) => {
    res.json({
      skipOpenAI: String(process.env.SKIP_OPENAI),
      model: process.env.OPENAI_MODEL || null,
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY)
    });
  });

  // NEW: quick check of incoming userId sources
  app.get('/api/debug/whoami', requireApiKey, (req, res) => {
    res.json({
      headerUserId: req.header('x-user-id') || null,
      queryUserId: req.query.userId || null,
      bodyUserId: req.body?.userId || null
    });
  });
}

app.get('/', (req, res) => res.type('text').send('Outfitted API is running. Try GET /healthz'));
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

// AI: describe a clothing photo (used by the app's "AI: Auto-fill" button)
app.post('/api/closet/describe', requireApiKey, async (req, res, next) => {
  try {
    const { imageUrl } = DescribeSchema.parse(req.body);
    const data = await describeImage({ imageUrl });
    res.json({ data });
  } catch (err) { next(err); }
});

// ------- Closet: list/search (supports scope=mine|blended|catalog) -------
// ------- Closet: list/search (supports scope=mine|blended|catalog) -------
app.get('/api/closet', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUserId(req);
    const { q, limit = 200 } = req.query;
    const scope = String(req.query.scope || 'blended').toLowerCase();

    const nameFilter = q
      ? `FIND(LOWER("${esc(String(q).toLowerCase())}"), LOWER({${CLOSET_NAME_FIELD}}))`
      : null;

    let scopeFilter;
    if (scope === 'mine') {
      if (!uid) return res.json({ count: 0, items: [], data: [] });
      scopeFilter = `{${CLOSET_USER_FIELD}}='${esc(uid)}'`;
    } else if (scope === 'catalog') {
      scopeFilter = `{${CLOSET_USER_FIELD}}=BLANK()`;
    } else {
      scopeFilter = uid
        ? `OR({${CLOSET_USER_FIELD}}='${esc(uid)}', {${CLOSET_USER_FIELD}}=BLANK())`
        : `{${CLOSET_USER_FIELD}}=BLANK()`;
    }

    // ✅ Airtable pageSize must be <= 100. Use maxRecords for the total cap.
    const requested   = parseInt(String(limit), 10) || 100;
    const pageSize    = Math.min(Math.max(requested, 1), 100);   // 1..100
    const maxRecords  = Math.min(Math.max(requested, 1), 1000);  // cap total fetched

    const cfg = { pageSize, maxRecords };
    const filters = [nameFilter, scopeFilter].filter(Boolean);
    cfg.filterByFormula = filters.length === 1 ? filters[0] : `AND(${filters.join(',')})`;

    const records = await tbCloset.select(cfg).all();

    const items = records.map(r => {
      const owner = String(readField(r.fields, CLOSET_USER_FIELD, [USER_ID_FIELD]) || '').trim();
      return {
        id: r.id,
        name: readField(r.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']),
        category: readField(r.fields, CLOSET_CATEGORY_FIELD, ['Category']),
        brand: readField(r.fields, CLOSET_BRAND_FIELD, ['Brand']),
        color: readField(r.fields, CLOSET_COLOR_FIELD, ['Color','Colors']),
        imageUrl: readPhotoFromFields(r.fields),
        source: owner ? 'mine' : 'catalog',
        ownerUserId: owner || ''
      };
    });

    res.set('Cache-Control', 'no-store');
    res.json({ count: items.length, items, data: items });
  } catch (err) { next(err); }
});


// ------- Closet: create (stores user id; typecast true; normalized response) -------
app.post('/api/closet', requireApiKey, async (req, res, next) => {
  try {
    const uid = requireUserId(req); // enforce a user id on create

    const { name, category, color, brand, imageUrl } = CreateClosetItemSchema.parse(req.body);

    const fields = {
      [CLOSET_NAME_FIELD]: name,
      [CLOSET_CATEGORY_FIELD]: category,
      [CLOSET_COLOR_FIELD]: color || '',
      [CLOSET_BRAND_FIELD]: brand || '',
      [USER_ID_FIELD]: uid // write to actual column
    };
    if (imageUrl) {
      if (CLOSET_PHOTO_IS_ATTACHMENT) fields[CLOSET_PHOTO_FIELD] = [{ url: imageUrl }];
      else fields[CLOSET_PHOTO_FIELD] = imageUrl;
      fields['Image URL'] = imageUrl; // mirror to plain URL column if present
    }

    const recs = await tbCloset.create([{ fields }], { typecast: true });
    const r = recs[0];

    const item = {
      id: r.id,
      name: readField(r.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']),
      category: readField(r.fields, CLOSET_CATEGORY_FIELD, ['Category']),
      brand: readField(r.fields, CLOSET_BRAND_FIELD, ['Brand']),
      color: readField(r.fields, CLOSET_COLOR_FIELD, ['Color','Colors']),
      imageUrl: readPhotoFromFields(r.fields),
      source: 'mine',
      ownerUserId: uid
    };

    res.status(201).json({ data: item, item, message: 'created' }); // dual shape
  } catch (err) { next(err); }
});

// ------- Closet: update (only your own; unified user id) -------
app.put('/api/closet/:id', requireApiKey, async (req, res, next) => {
  try {
    const uid = requireUserId(req);
    const current = await tbCloset.find(req.params.id);
    if ((current.fields[USER_ID_FIELD] || '') !== uid) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your item' } });
    }

    const patch = UpdateClosetItemSchema.parse(req.body);
    const fields = {};
    if (patch.name != null)     fields[CLOSET_NAME_FIELD] = patch.name;
    if (patch.category != null) fields[CLOSET_CATEGORY_FIELD] = patch.category;
    if (patch.color != null)    fields[CLOSET_COLOR_FIELD] = patch.color || '';
    if (patch.brand != null)    fields[CLOSET_BRAND_FIELD] = patch.brand || '';
    if (patch.imageUrl !== undefined) {
      if (CLOSET_PHOTO_IS_ATTACHMENT) fields[CLOSET_PHOTO_FIELD] = patch.imageUrl ? [{ url: patch.imageUrl }] : [];
      else fields[CLOSET_PHOTO_FIELD] = patch.imageUrl || '';
      fields['Image URL'] = patch.imageUrl || '';
    }

    const recs = await tbCloset.update([{ id: req.params.id, fields }], { typecast: true });
    const r = recs[0];
    const item = {
      id: r.id,
      name: readField(r.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']),
      category: readField(r.fields, CLOSET_CATEGORY_FIELD, ['Category']),
      brand: readField(r.fields, CLOSET_BRAND_FIELD, ['Brand']),
      color: readField(r.fields, CLOSET_COLOR_FIELD, ['Color','Colors']),
      imageUrl: readPhotoFromFields(r.fields),
      source: 'mine',
      ownerUserId: uid
    };
    res.json({ data: item, item });
  } catch (err) { next(err); }
});

// ------- Closet: delete (only your own; unified user id) -------
app.delete('/api/closet/:id', requireApiKey, async (req, res, next) => {
  try {
    const uid = requireUserId(req);
    const current = await tbCloset.find(req.params.id);
    if ((current.fields[USER_ID_FIELD] || '') !== uid) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your item' } });
    }
    await tbCloset.destroy(req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ------- Listings: public marketplace (no user filter) -------
app.get('/api/listings', requireApiKey, async (req, res, next) => {
  try {
    const records = await tbListings.select({
      filterByFormula: "{status} = 'Active'",
      pageSize: 100
    }).all();

    const listings = records.map(r => ({
      id:          r.id,
      name:        r.fields['Name']        ?? null,
      price:       r.fields['Price']       ?? 0,
      size:        r.fields['Size']        ?? null,
      category:    r.fields['Category']    ?? null,
      condition:   r.fields['Condition']   ?? null,
      description: r.fields['Description'] ?? null,
      imageUrl:    r.fields['Image URL']   ?? null,
      sellerId:    r.fields['Seller ID']   ?? null,
      sellerName:  r.fields['Seller Name'] ?? null,
      status:      r.fields['Status']      ?? null,
    }));

    res.set('Cache-Control', 'no-store');
    res.json(listings);
  } catch (err) { next(err); }
});

// ------- Listings: create -------
app.post('/api/listings', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUserId(req);
    const { name, price, size, condition, description, sellerName, imageUrl } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'name is required' } });
    }
    if (typeof price !== 'number' || price <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'price must be a positive number' } });
    }

    const fields = {
      'Name':        name,
      'Price':       price,
      'Status':      'Active',
    };
    if (size)        fields['Size']        = size;
    if (condition)   fields['Condition']   = condition;
    if (description) fields['Description'] = description;
    if (uid)         fields['Seller ID']   = uid;
    if (sellerName)  fields['Seller Name'] = sellerName;
    if (imageUrl)    fields['Image URL']   = imageUrl;

    const recs = await tbListings.create([{ fields }], { typecast: true });
    const r = recs[0];

    res.status(201).json({
      id:          r.id,
      name:        r.fields['Name']        ?? null,
      price:       r.fields['Price']       ?? price,
      size:        r.fields['Size']        ?? null,
      category:    r.fields['Category']    ?? null,
      condition:   r.fields['Condition']   ?? null,
      description: r.fields['Description'] ?? null,
      imageUrl:    r.fields['Image URL']   ?? null,
      sellerId:    r.fields['Seller ID']   ?? null,
      sellerName:  r.fields['Seller Name'] ?? null,
      status:      r.fields['Status']      ?? 'Active',
    });
  } catch (err) { next(err); }
});

// ------- Listings: edit (price, condition, description) -------
app.patch('/api/listings/:id', requireApiKey, async (req, res, next) => {
  try {
    const { price, condition, description } = req.body;
    const fields = {};
    if (price       !== undefined) fields['Price']       = price;
    if (condition   !== undefined) fields['Condition']   = condition;
    if (description !== undefined) fields['Description'] = description;

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'No updatable fields provided' } });
    }

    const r = await tbListings.update(req.params.id, fields);
    res.json({
      id:          r.id,
      price:       r.fields['Price']       ?? null,
      condition:   r.fields['Condition']   ?? null,
      description: r.fields['Description'] ?? null,
      status:      r.fields['Status']      ?? null,
    });
  } catch (err) { next(err); }
});

// ------- Listings: unlist (set status Inactive) -------
app.delete('/api/listings/:id', requireApiKey, async (req, res, next) => {
  try {
    await tbListings.update(req.params.id, { 'Status': 'Sold' });
    res.status(204).send();
  } catch (err) { next(err); }
});

// ------- Suggest outfits (stub if SKIP_OPENAI=true) -------
app.post('/api/outfits/suggest', requireApiKey, async (req, res, next) => {
  req.log.info('USING_STUB_SUGGEST');
  try {
    const parsed = OutfitSuggestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.flatten() } });
    }

    const { occasion, weather, style, itemIds, topK } = parsed.data;
    const items = await fetchClosetItemsByIds(itemIds);
    if (!items.length) return res.status(400).json({ error: { code: 'NO_ITEMS', message: 'Provide valid itemIds' } });

    const outfits = (String(SKIP_OPENAI).toLowerCase() === 'true')
      ? [{
          name: `${style ? `${style} ` : ''}${occasion} fit`.trim(),
          items: items.map(i => i.id),
          reasoning: `Server stub (no AI): combined ${items.length} item(s) for ${occasion}${style ? ` in ${style} style.` : '.'}`,
          palette: Array.from(new Set(items.map(i => String(i.fields['Color'] || i.fields['Colors'] || '').trim()).filter(Boolean))).slice(0,5),
          preview: ''
        }]
      : await generateOutfitsWithAI({ items, occasion, weather, style, topK });

    const created = [];
    for (const o of outfits) {
      const fields = {
        [OUTFITS_NAME_FIELD]: o.name,
        [OUTFITS_ITEMS_FIELD]: items.map(i => i.id),
        [OUTFITS_OCCASION_FIELD]: occasion,
        [OUTFITS_STYLE_FIELD]: style || '',
        [OUTFITS_WEATHER_FIELD]: weather || '',
        [OUTFITS_REASON_FIELD]: o.reasoning || '',
        [OUTFITS_PALETTE_FIELD]: Array.isArray(o.palette) ? o.palette.join(', ') : '',
        [USER_ID_FIELD]: getUserId(req)
      };
      if (o.preview) {
        if (OUTFITS_PHOTO_IS_ATTACHMENT) fields[OUTFITS_PHOTO_FIELD] = [{ url: o.preview }];
        else fields[OUTFITS_PHOTO_FIELD] = o.preview;
      }
      const rec = await tbOutfits.create([{ fields }], { typecast: true });
      created.push({ id: rec[0].id, fields });
    }

    res.status(201).json({ data: created.map(c => ({ id: c.id, ...c.fields })) });
  } catch (err) { next(err); }
});

// ------- Outfits: save exact items (stores user id) -------
app.post('/api/outfits/save', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUserId(req);
    const { title, itemIds, occasion, style, weather, reasoning, palette, photoUrl } =
      SaveOutfitSchema.parse(req.body);

    // Validate the items exist
    const items = await fetchClosetItemsByIds(itemIds);
    if (items.length !== itemIds.length) {
      return res.status(400).json({
        error: { code: 'ITEMS_NOT_FOUND', message: 'Some itemIds are invalid', details: { requested: itemIds.length, found: items.length } }
      });
    }

    const fields = {
      [OUTFITS_NAME_FIELD]: title,
      [OUTFITS_ITEMS_FIELD]: itemIds,
      [OUTFITS_OCCASION_FIELD]: occasion || '',
      [OUTFITS_STYLE_FIELD]: style || '',
      [OUTFITS_WEATHER_FIELD]: weather || '',
      [OUTFITS_REASON_FIELD]: reasoning || '',
      [OUTFITS_PALETTE_FIELD]: Array.isArray(palette) ? palette.join(', ') : '',
      [USER_ID_FIELD]: uid
    };
    if (photoUrl) {
      if (OUTFITS_PHOTO_IS_ATTACHMENT) fields[OUTFITS_PHOTO_FIELD] = [{ url: photoUrl }];
      else fields[OUTFITS_PHOTO_FIELD] = photoUrl;
    }

    const recs = await tbOutfits.create([{ fields }], { typecast: true });
    const created = recs[0];

    return res.status(201).json({
      data: { id: created.id, title, items: itemIds, occasion, style, weather, reasoning, palette, photoUrl }
    });
  } catch (err) { next(err); }
});

// ------- Outfits: archive list (scoped to user) -------
app.get('/api/outfits/archive', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUserId(req);
    const recs = await tbOutfits.select({
      pageSize: 100,
      filterByFormula: `{${USER_ID_FIELD}}='${esc(uid)}'`
    }).all();

    const outfits = [];
    const needClosetIds = new Set();
    recs.forEach(r => {
      const linkedIds = Array.isArray(r.fields[OUTFITS_ITEMS_FIELD]) ? r.fields[OUTFITS_ITEMS_FIELD] : [];
      linkedIds.forEach(id => needClosetIds.add(id));
      outfits.push({
        id: r.id,
        title: r.fields[OUTFITS_NAME_FIELD] || 'Saved outfit',
        itemIds: linkedIds,
        photo: firstUrl(r.fields[OUTFITS_PHOTO_FIELD]),
      });
    });

    const items = await fetchClosetItemsByIds([...needClosetIds]);
    const catalog = {};
    for (const it of items) {
      const name = readField(it.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']) || '';
      const photo = readPhotoFromFields(it.fields);
      if (name) catalog[name] = { photoUrl: photo };
    }

    const closetById = new Map(items.map(i => [i.id, i]));
    const normalized = outfits.map(o => ({
      id: o.id,
      title: o.title,
      items: o.itemIds
        .map(id => closetById.get(id))
        .filter(Boolean)
        .map(rec => readField(rec.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item'])),
      photo: o.photo || ''
    }));

    res.json({ outfits: normalized, catalog });
  } catch (err) { next(err); }
});

// ------- Outfits: delete saved look -------
app.delete('/api/outfits/:id', requireApiKey, async (req, res, next) => {
  try {
    const uid = requireUserId(req);
    const curr = await tbOutfits.find(req.params.id);
    if ((curr.fields[USER_ID_FIELD] || '') !== uid) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your look' } });
    }
    await tbOutfits.destroy(req.params.id);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ------- Cloudinary signing endpoint -------
app.post('/api/uploads/cloudinary/sign', requireApiKey, async (req, res) => {
  try {
    if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
      return res.status(500).json({ error: { code: 'NO_CLOUDINARY', message: 'Cloudinary env vars missing' } });
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = CLOUDINARY_FOLDER || 'outfitted';
    const paramsToSign = { folder, timestamp };
    const toSign =
      Object.keys(paramsToSign)
        .sort()
        .map(k => `${k}=${paramsToSign[k]}`)
        .join('&') + CLOUDINARY_API_SECRET;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');

    return res.json({
      cloudName: CLOUDINARY_CLOUD_NAME,
      apiKey: CLOUDINARY_API_KEY,
      timestamp,
      signature,
      folder
    });
  } catch (e) {
    res.status(500).json({ error: { code: 'SIGN_FAILED', message: e?.message || 'Sign error' } });
  }
});

// ------- Orders: create (listing checkout) -------
app.post('/api/orders', requireApiKey, async (req, res, next) => {
  try {
    const buyerId = requireUserId(req);
    const { listingId, listingName, price, sellerId, sellerName, imageUrl } = req.body;

    if (!listingId || typeof listingId !== 'string') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'listingId is required' } });
    }
    if (typeof price !== 'number' || price <= 0) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'price must be a positive number' } });
    }

    const fields = {
      'Listing ID':   listingId,
      'Listing Name': listingName || '',
      'Price':        price,
      'Buyer ID':     buyerId,
      'Seller ID':    sellerId   || '',
      'Seller Name':  sellerName || '',
      'Status':       'Pending',
      'Created At':   new Date().toISOString(),
      'Image URL':    imageUrl   || '',
    };

    const recs = await tbOrders.create([{ fields }], { typecast: true });
    const r = recs[0];

    // Mark the listing Sold so it disappears from the marketplace
    if (listingId) {
      tbListings.update(listingId, { 'Status': 'Sold' }).catch((e) => {
        req.log.warn({ msg: 'Failed to mark listing Sold', listingId, err: e.message });
      });
    }

    res.status(201).json({
      id:          r.id,
      listingId:   r.fields['Listing ID']   ?? listingId,
      listingName: r.fields['Listing Name'] ?? listingName,
      price:       r.fields['Price']        ?? price,
      buyerId:     r.fields['Buyer ID']     ?? buyerId,
      sellerId:    r.fields['Seller ID']    ?? sellerId,
      sellerName:  r.fields['Seller Name']  ?? sellerName,
      status:      r.fields['Status']       ?? 'Pending',
      createdAt:   r.fields['Created At']   ?? fields['Created At'],
      imageUrl:    r.fields['Image URL']    ?? imageUrl,
    });
  } catch (err) { next(err); }
});

// ------- Orders: fetch all for current user (buyer OR seller) -------
app.get('/api/orders', requireApiKey, async (req, res, next) => {
  try {
    const uid = requireUserId(req);
    const safeUid = esc(uid);

    // Airtable doesn't support OR across two different text fields, so fetch both sides separately
    const [buyerRecs, sellerRecs] = await Promise.all([
      tbOrders.select({ filterByFormula: `{Buyer ID}  = '${safeUid}'`, pageSize: 100 }).all(),
      tbOrders.select({ filterByFormula: `{Seller ID} = '${safeUid}'`, pageSize: 100 }).all(),
    ]);

    const seen = new Set();
    const normalise = (r) => {
      if (seen.has(r.id)) return null;
      seen.add(r.id);
      return {
        id:          r.id,
        listingId:   r.fields['Listing ID']   ?? '',
        listingName: r.fields['Listing Name'] ?? '',
        price:       r.fields['Price']        ?? 0,
        buyerId:     r.fields['Buyer ID']     ?? '',
        sellerId:    r.fields['Seller ID']    ?? '',
        sellerName:  r.fields['Seller Name']  ?? '',
        status:      r.fields['Status']       ?? 'Pending',
        createdAt:   r.fields['Created At']   ?? '',
        imageUrl:    r.fields['Image URL']    ?? '',
      };
    };

    const orders = [...buyerRecs, ...sellerRecs].map(normalise).filter(Boolean);
    orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.set('Cache-Control', 'no-store');
    res.json(orders);
  } catch (err) { next(err); }
});

// ------- Orders: update status (seller progression only) -------
app.patch('/api/orders/:id', requireApiKey, async (req, res, next) => {
  try {
    const ALLOWED = ['Confirmed', 'Shipped', 'Delivered'];
    const { status } = req.body;
    if (!status || !ALLOWED.includes(status)) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: `status must be one of: ${ALLOWED.join(', ')}` } });
    }
    const r = await tbOrders.update(req.params.id, { 'Status': status });
    res.json({ id: r.id, status: r.fields['Status'] ?? status });
  } catch (err) { next(err); }
});

// ------- Retailer source helpers -------

async function fetchAsosProducts(query, limit, offset, log) {
  if (!RAPIDAPI_KEY) {
    log?.warn({ msg: 'RAPIDAPI_KEY not set — skipping ASOS' });
    return [];
  }

  const params = new URLSearchParams({
    searchTerm: query,
    store:      'US',
    lang:       'en-US',
    currency:   'USD',
    sizeSchema: 'US',
    limit:      String(limit),
    offset:     String(offset),
  });
  const url = `https://asos10.p.rapidapi.com/api/v1/getProductListBySearchTerm?${params.toString()}`;
  log?.info({ msg: 'ASOS request', url, keyPrefix: RAPIDAPI_KEY.slice(0, 8) + '...' });

  const res  = await fetch(url, {
    method: 'GET',
    headers: { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': 'asos10.p.rapidapi.com' },
  });
  const text = await res.text().catch(() => '');
  log?.info({ msg: 'ASOS response', status: res.status, body: text.slice(0, 800) });

  if (!res.ok) {
    log?.error({ msg: 'ASOS error', status: res.status, body: text.slice(0, 300) });
    throw new Error(`ASOS API ${res.status}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('ASOS non-JSON response'); }

  log?.info({ msg: 'ASOS data keys', keys: Object.keys(data ?? {}) });

  // asos10 may return: { data: { products: [...] } } | { data: [...] } | { products: [...] } | [...]
  let raw = [];
  if (Array.isArray(data))                       raw = data;
  else if (Array.isArray(data?.data?.products))  raw = data.data.products;
  else if (Array.isArray(data?.data))            raw = data.data;
  else if (Array.isArray(data?.products))        raw = data.products;

  log?.info({ msg: 'ASOS raw count', count: raw.length });
  if (raw.length > 0) log?.info({ msg: 'ASOS first product keys', keys: Object.keys(raw[0]) });

  const resolvePrice = (item) => {
    const v = item.price?.current?.value ?? item.price?.value ?? item.priceData?.current ?? item.currentPrice;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseFloat(v.replace(/[^0-9.]/g, '')) || 0;
    return 0;
  };
  const resolveUrl = (item) => {
    const u = item.url ?? item.productUrl ?? item.link ?? '';
    if (!u) return null;
    if (u.startsWith('http')) return u;
    if (u.startsWith('//'))   return `https:${u}`;
    return `https://www.asos.com${u.startsWith('/') ? '' : '/'}${u}`;
  };
  const resolveImageUrl = (item) => {
    const v = item.imageUrl ?? item.image ?? item.imageLink ?? null;
    if (!v) return null;
    if (v.startsWith('images.asos-media.com')) return `https://${v}`;
    if (v.startsWith('//')) return `https:${v}`;
    return v;
  };

  return raw.map(item => ({
    id:         String(item.id ?? item.productId ?? Math.random()),
    name:       item.name ?? item.productName ?? item.title ?? 'Unnamed product',
    brand:      item.brandName ?? item.brand?.name ?? item.brand ?? 'ASOS',
    price:      resolvePrice(item),
    imageUrl:   resolveImageUrl(item),
    productUrl: resolveUrl(item),
    retailer:   'ASOS',
  }));
}

async function fetchEbayProducts(query, limit, offset, log) {
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CERT_ID) {
    log?.warn({ msg: 'EBAY_CLIENT_ID / EBAY_CERT_ID not set — skipping eBay' });
    return [];
  }

  // Refresh token if missing or expiring within the next 5 minutes
  console.log('[eBay] fetchEbayProducts — token present:', !!ebayAccessToken, '| expired:', Date.now() >= tokenExpiresAt);
  if (!ebayAccessToken || Date.now() >= tokenExpiresAt) {
    log?.info({ msg: 'Refreshing eBay access token' });
    await refreshEbayToken();
    log?.info({ msg: 'eBay token refreshed', expiresAt: new Date(tokenExpiresAt).toISOString() });
  }

  const params = new URLSearchParams({
    q:            query,
    limit:        String(limit),
    offset:       String(offset),
    category_ids: '11450', // eBay Clothing, Shoes & Accessories
  });
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?${params.toString()}`;
  log?.info({ msg: 'eBay request', url });
  console.log('[eBay] Browse API request:', url);

  const res  = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization':           `Bearer ${ebayAccessToken}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      'Content-Type':            'application/json',
    },
  });
  const text = await res.text().catch(() => '');
  log?.info({ msg: 'eBay response', status: res.status, body: text.slice(0, 800) });
  console.log('[eBay] Browse API response status:', res.status, '| body preview:', text.slice(0, 500));

  if (!res.ok) {
    log?.error({ msg: 'eBay error', status: res.status, body: text.slice(0, 300) });
    throw new Error(`eBay API ${res.status}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error('eBay non-JSON response'); }

  const raw = Array.isArray(data?.itemSummaries) ? data.itemSummaries : [];
  log?.info({ msg: 'eBay raw count', count: raw.length });
  console.log('[eBay] itemSummaries count:', raw.length, '| response top-level keys:', Object.keys(data ?? {}));
  if (raw.length > 0) log?.info({ msg: 'eBay first item keys', keys: Object.keys(raw[0]) });
  if (raw.length === 0) console.log('[eBay] WARNING: no itemSummaries — full response keys:', Object.keys(data ?? {}), '| body:', text.slice(0, 800));

  return raw
    .map(item => ({
      id:         String(item.itemId ?? Math.random()),
      name:       item.title ?? 'Unnamed product',
      brand:      item.seller?.username ?? 'eBay Seller',
      price:      parseFloat(item.price?.value ?? item.buyingOptions?.[0] ?? '0') || 0,
      imageUrl:   item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
      productUrl: item.itemWebUrl ?? null,
      retailer:   'eBay',
    }))
    .filter(item => item.imageUrl && item.productUrl);
}

// Fisher-Yates shuffle — blends eBay and ASOS results instead of grouping by source
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------- Retailers: ASOS + eBay blended feed -------
app.get('/api/retailers', requireApiKey, async (req, res, next) => {
  try {
    const query  = req.query.query ? String(req.query.query) : 'trending';
    const limit  = Math.min(parseInt(String(req.query.limit  || '20'), 10) || 20, 48);
    const offset = Math.max(parseInt(String(req.query.offset || '0'),  10) || 0,  0);

    const [asosResult, ebayResult] = await Promise.allSettled([
      fetchAsosProducts(query, limit, offset, req.log),
      fetchEbayProducts(query, limit, offset, req.log),
    ]);

    if (asosResult.status === 'rejected') {
      req.log.error({ msg: 'ASOS fetch failed', err: asosResult.reason?.message });
    }
    if (ebayResult.status === 'rejected') {
      req.log.error({ msg: 'eBay fetch failed', err: ebayResult.reason?.message });
    }

    const asosProducts = asosResult.status  === 'fulfilled' ? asosResult.value : [];
    const ebayProducts = ebayResult.status  === 'fulfilled' ? ebayResult.value : [];

    // Deduplicate by product ID before shuffling (prevents the same item appearing twice
    // when ASOS and eBay return overlapping results or on paginated re-fetches)
    const seen    = new Set();
    const deduped = [...asosProducts, ...ebayProducts].filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    const combined = shuffleArray(deduped);

    req.log.info({
      msg:        'Retailer products combined',
      asos:       asosProducts.length,
      ebay:       ebayProducts.length,
      duplicates: (asosProducts.length + ebayProducts.length) - deduped.length,
      total:      combined.length,
    });

    res.set('Cache-Control', 'public, max-age=300'); // 5 min — reduce API quota usage
    res.json(combined);
  } catch (err) { next(err); }
});

// ---------- ERROR HANDLER ----------
/* eslint-disable no-unused-vars */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const payload = { code: err.code || 'INTERNAL_ERROR', message: err.message || 'Unexpected server error', details: err.details, requestId: req.id };
  req.log?.error?.({ err, status, path: req.path, requestId: req.id });
  res.status(status).json({ error: payload });
});
/* eslint-enable no-unused-vars */

// ---------- BOOT ----------
app.listen(PORT, () => { console.log(`✅ Outfitted API on ${PORT} (${NODE_ENV})`); });
