// server.js
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
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_CLOSET = 'Clothing Items',
  AIRTABLE_TABLE_OUTFITS = 'Outfits',
  AIRTABLE_TABLE_ORDERS = 'Orders',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  API_KEY,
  ALLOWED_ORIGINS = '',

  // Clothing Items fields
  CLOSET_NAME_FIELD = 'Item Name',
  CLOSET_CATEGORY_FIELD = 'Category',
  CLOSET_BRAND_FIELD = 'Brand',
  CLOSET_COLOR_FIELD = 'Color',
  CLOSET_PHOTO_FIELD = 'Photo', // attachment or url
  CLOSET_PHOTO_AS_ATTACHMENT = 'true',
  CLOSET_USER_FIELD = 'User Id', // <-- ensure this field exists (single line text)

  // Outfits fields
  OUTFITS_NAME_FIELD = 'Title',
  OUTFITS_ITEMS_FIELD = 'Items', // linked to "Clothing Items"
  OUTFITS_PHOTO_FIELD = 'Photo',
  OUTFITS_STATUS_FIELD = 'Status',
  OUTFITS_REASON_FIELD = 'AI Reasoning',
  OUTFITS_PALETTE_FIELD = 'Palette',
  OUTFITS_OCCASION_FIELD = 'Occasion',
  OUTFITS_STYLE_FIELD = 'Style',
  OUTFITS_WEATHER_FIELD = 'Weather',
  OUTFITS_PHOTO_AS_ATTACHMENT = 'true',
  OUTFITS_USER_FIELD = 'User Id', // <-- ensure this field exists (single line text)

  // Optional: bypass OpenAI for debugging
  SKIP_OPENAI = 'false',

  // Cloudinary
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
  CLOUDINARY_FOLDER = 'outfitted'
} = process.env;

// --- User scoping ---
const USER_ID_FIELD = 'User Id'; // Airtable text field in BOTH tables
const getUid = (req) => String(req.header('x-user-id') || '').trim();

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
app.use(express.json({ limit: '2mb' }));
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
const tbCloset  = base(AIRTABLE_TABLE_CLOSET);
const tbOutfits = base(AIRTABLE_TABLE_OUTFITS);
const tbOrders  = base(AIRTABLE_TABLE_ORDERS);
const openai    = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- UTILS ----------
const esc = (s = '') => String(s).replace(/'/g, "\\'");
const getUserId = (req) => (req.header('x-user-id') || req.query.userId || '').toString().trim() || null;

function readField(obj, key, fallbacks = []) {
  if (obj[key] != null) return obj[key];
  for (const fb of fallbacks) if (obj[fb] != null) return obj[fb];
  return undefined;
}
function firstUrl(val) {
  if (Array.isArray(val) && val[0]?.url) return val[0].url; // attachment
  if (typeof val === 'string') return val;                   // plain URL
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
const CreateOrderSchema = z.object({
  userId: z.string().min(1),
  outfitId: z.string().min(1),
  fulfillment: z.enum(['delivery','pickup','stylist']).default('delivery'),
  note: z.string().max(2000).optional().default(''),
  idempotencyKey: z.string().min(1)
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
      photo: firstUrl(readField(i.fields, CLOSET_PHOTO_FIELD, ['Photo','Image URL']))
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

// ---------- ROUTES ----------
// Debug routes only in non-production
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
}

app.get('/', (req, res) => res.type('text').send('Outfitted API is running. Try GET /healthz'));
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));
// AI: describe a clothing photo (used by the app's "AI: Auto-fill" button)
app.post('/api/closet/describe', requireApiKey, async (req, res, next) => {
  try {
    const { imageUrl } = DescribeSchema.parse(req.body); // validates { imageUrl }
    const data = await describeImage({ imageUrl });      // calls OpenAI (or stub if SKIP_OPENAI=true)
    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// ------- Closet: list/search (scoped: this user OR global blank) -------
app.get('/api/closet', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUserId(req);
    const { q, limit = 200 } = req.query;

    const nameFilter = q
      ? `FIND(LOWER("${esc(String(q).toLowerCase())}"), LOWER({${CLOSET_NAME_FIELD}}))`
      : null;

    const scopeFilter = uid
      ? `OR({${CLOSET_USER_FIELD}}='${esc(uid)}', {${CLOSET_USER_FIELD}}=BLANK())`
      : null;

    const filters = [nameFilter, scopeFilter].filter(Boolean);
    const cfg = { pageSize: Math.min(Number(limit) || 200, 200) };
    if (filters.length) {
      cfg.filterByFormula = filters.length === 1 ? filters[0] : `AND(${filters.join(',')})`;
    }

    const records = await tbCloset.select(cfg).all();

    const data = records.map(r => {
      const rawPhoto = readField(r.fields, CLOSET_PHOTO_FIELD, ['Photo','Image URL']);
      return {
        id: r.id,
        name: readField(r.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']),
        category: readField(r.fields, CLOSET_CATEGORY_FIELD, ['Category']),
        brand: readField(r.fields, CLOSET_BRAND_FIELD, ['Brand']),
        color: readField(r.fields, CLOSET_COLOR_FIELD, ['Color','Colors']),
        imageUrl: firstUrl(rawPhoto)
      };
    });

    res.json({ data });
  } catch (err) { next(err); }
});

// ------- Closet: create (stores user id) -------
app.post('/api/closet', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUid(req);
    const { name, category, color, brand, imageUrl } = CreateClosetItemSchema.parse(req.body);
    const fields = {
  [CLOSET_NAME_FIELD]: name,
  [CLOSET_CATEGORY_FIELD]: category,
  [CLOSET_COLOR_FIELD]: color || '',
  [CLOSET_BRAND_FIELD]: brand || '',
  [USER_ID_FIELD]: uid,             // ✅ correct computed property
};
if (imageUrl) {
  if (CLOSET_PHOTO_IS_ATTACHMENT) fields[CLOSET_PHOTO_FIELD] = [{ url: imageUrl }];
  else fields[CLOSET_PHOTO_FIELD] = imageUrl;
}
const recs = await tbCloset.create([{ fields }], { typecast: true });
    const r = recs[0];
    res.status(201).json({
      data: { id: r.id, name, category, color, brand, imageUrl: imageUrl || '' }
    });
  } catch (err) { next(err); }
});

// ------- Closet: update -------
app.put('/api/closet/:id', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUid(req);
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
    }

    const recs = await tbCloset.update([{ id: req.params.id, fields }], { typecast: true });
    const r = recs[0];
    const rawPhoto = readField(r.fields, CLOSET_PHOTO_FIELD, ['Photo','Image URL']);
    res.json({
      data: {
        id: r.id,
        name: readField(r.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']),
        category: readField(r.fields, CLOSET_CATEGORY_FIELD, ['Category']),
        brand: readField(r.fields, CLOSET_BRAND_FIELD, ['Brand']),
        color: readField(r.fields, CLOSET_COLOR_FIELD, ['Color','Colors']),
        imageUrl: firstUrl(rawPhoto)
      }
    });
  } catch (err) { next(err); }
});

// ------- Closet: delete -------
app.delete('/api/closet/:id', requireApiKey, async (req, res, next) => {
  try {
    const uid = getUid(req);
    const current = await tbCloset.find(req.params.id);
    if ((current.fields[USER_ID_FIELD] || '') !== uid) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your item' } });
    }
    await tbCloset.destroy(req.params.id);
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
  [USER_ID_FIELD]: getUid(req),   // ✅ add user scope
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
  [USER_ID_FIELD]: uid,            // ✅ add user scope
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
    const uid = getUid(req);
    const recs = await tbOutfits.select({
      pageSize: 100,
      filterByFormula: `{${USER_ID_FIELD}}='${uid}'`
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
      const photo = firstUrl(readField(it.fields, CLOSET_PHOTO_FIELD, ['Photo','Image URL']));
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
    const uid = getUid(req);
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

// ------- Orders (idempotent) -------
app.post('/api/orders', requireApiKey, async (req, res, next) => {
  try {
    const { userId, outfitId, fulfillment, note, idempotencyKey } =
      CreateOrderSchema.parse(req.body);

    const safeKey = String(idempotencyKey).replace(/'/g, "\\'");
    const existing = await tbOrders.select({ maxRecords: 1, filterByFormula: `{Idempotency Key} = '${safeKey}'` }).firstPage();
    if (existing.length) {
      const r = existing[0];
      return res.status(200).json({ data: { id: r.id, ...r.fields } });
    }

    const outfit = await tbOutfits.find(outfitId).catch(() => null);
    if (!outfit) return res.status(404).json({ error: { code: 'OUTFIT_NOT_FOUND', message: 'Invalid outfitId' } });

    const fields = {
      'User Id': userId,
      'Outfit': [outfitId],
      'Status': 'pending',
      'Fulfillment': fulfillment,
      'Note': note || '',
      'Idempotency Key': idempotencyKey
    };

    const recs = await tbOrders.create([{ fields }]);
    return res.status(201).json({ data: { id: recs[0].id, ...fields } });
  } catch (err) { next(err); }
});

app.get('/api/orders/:id', requireApiKey, async (req, res, next) => {
  try {
    const rec = await tbOrders.find(req.params.id);
    res.json({ data: { id: rec.id, ...rec.fields } });
  } catch (err) {
    if (String(err).includes('NOT_FOUND')) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
    next(err);
  }
});

// ---------- ERROR HANDLER ----------
/* eslint-disable no-unused-vars */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const payload = { code: err.code || 'INTERNAL_ERROR', message: err.message || 'Unexpected server error', details: err.details, requestId: req.id };
  req.log.error({ err, status, path: req.path, requestId: req.id });
  res.status(status).json({ error: payload });
});
/* eslint-enable no-unused-vars */

// ---------- BOOT ----------
app.listen(PORT, () => { console.log(`✅ Outfitted API on ${PORT} (${NODE_ENV})`); });
