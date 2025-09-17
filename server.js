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
  API_KEY,
  ALLOWED_ORIGINS = '',

  // Clothing Items fields
  CLOSET_NAME_FIELD = 'Item Name',
  CLOSET_CATEGORY_FIELD = 'Category',
  CLOSET_BRAND_FIELD = 'Brand',
  CLOSET_COLOR_FIELD = 'Color',
  CLOSET_PHOTO_FIELD = 'Photo',
  CLOSET_PHOTO_AS_ATTACHMENT = 'true',

  // Outfits fields
  OUTFITS_NAME_FIELD = 'Title',
  OUTFITS_ITEMS_FIELD = 'Items',
  OUTFITS_PHOTO_FIELD = 'Photo',
  OUTFITS_STATUS_FIELD = 'Status',
  OUTFITS_REASON_FIELD = 'AI Reasoning',
  OUTFITS_PALETTE_FIELD = 'Palette',
  OUTFITS_OCCASION_FIELD = 'Occasion',
  OUTFITS_STYLE_FIELD = 'Style',
  OUTFITS_WEATHER_FIELD = 'Weather',
  OUTFITS_PHOTO_AS_ATTACHMENT = 'true'
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) { console.error('⚠️ Missing Airtable creds'); process.exit(1); }
if (!OPENAI_API_KEY) { console.error('⚠️ Missing OPENAI_API_KEY'); process.exit(1); }
if (!API_KEY) { console.error('⚠️ Missing API_KEY'); process.exit(1); }

// derived flags (must be outside the destructuring)
const CLOSET_PHOTO_IS_ATTACHMENT = String(CLOSET_PHOTO_AS_ATTACHMENT).toLowerCase() === 'true';
const OUTFITS_PHOTO_IS_ATTACHMENT = String(OUTFITS_PHOTO_AS_ATTACHMENT).toLowerCase() === 'true';

// ---------- CORE ----------
const app = express();
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

const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
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
const tbCloset = base(AIRTABLE_TABLE_CLOSET);
const tbOutfits = base(AIRTABLE_TABLE_OUTFITS);
const tbOrders = base(AIRTABLE_TABLE_ORDERS);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ---------- SCHEMAS ----------
const OutfitSuggestSchema = z.object({
  userId: z.string().optional(),
  occasion: z.string().min(1),
  weather: z.string().optional(),
  style: z.string().optional(),
  itemIds: z.array(z.string()).nonempty('Provide itemIds from Clothing Items'),
  topK: z.number().int().min(1).max(5).default(3)
});

const CreateOrderSchema = z.object({
  userId: z.string().min(1),
  outfitId: z.string().min(1),
  fulfillment: z.enum(['delivery', 'pickup', 'stylist']).default('delivery'),
  note: z.string().max(2000).optional()
});

// ---------- HELPERS ----------
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

async function fetchClosetItemsByIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const formula = `OR(${batch.map(id => `RECORD_ID() = '${id}'`).join(', ')})`;
    const page = await tbCloset.select({ filterByFormula: formula }).all();
    out.push(...page.map(r => ({ id: r.id, fields: r.fields })));
  }
  return out;
}

// ==== generateOutfitsWithAI (BEGIN) ====
async function generateOutfitsWithAI({ items, occasion, weather, style, topK }) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const system = `You are a fashion stylist AI. Return ONLY valid JSON:
{"outfits":[{"name":"string","items":["string"],"reasoning":"string","palette":["string"],"preview":""}]}`;

  const user = {
    occasion,
    weather: weather || '',
    style: style || '',
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

  // ---- Try Responses API first
  try {
    const r = await openai.responses.create({
      model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      text: { format: 'json' } 
    });
    const text = r.output_text || (r.output?.[0]?.content?.[0]?.text ?? '');
    const parsed = extractJson(text);
    if (!parsed) throw Object.assign(new Error('AI_JSON_PARSE_ERROR'), { status: 502, details: text?.slice?.(0, 400) });
    if (!parsed.outfits?.length) throw Object.assign(new Error('AI_EMPTY_OUTFITS'), { status: 502 });
    return parsed.outfits;
  } catch (e1) {
    // If Responses is blocked/unauthorized, fall back to Chat Completions
    if (e1?.status === 403 || /not authorized/i.test(e1?.message || '')) {
      try {
        const resp = await openai.chat.completions.create({
          model,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
          ]
        });
        const content = resp.choices?.[0]?.message?.content || '';
        const parsed = extractJson(content);
        if (!parsed) throw Object.assign(new Error('AI_JSON_PARSE_ERROR'), { status: 502, details: content?.slice?.(0, 400) });
        if (!parsed.outfits?.length) throw Object.assign(new Error('AI_EMPTY_OUTFITS'), { status: 502 });
        return parsed.outfits;
      } catch (e2) {
        const msg = e2?.response?.data?.error?.message || e2.message || 'OpenAI error';
        const status = e2?.status || e2?.response?.status || 502;
        throw Object.assign(new Error(`OPENAI_ERROR: ${msg}`), { status, details: e2?.response?.data });
      }
    }
    const msg = e1?.response?.data?.error?.message || e1.message || 'OpenAI error';
    const status = e1?.status || e1?.response?.status || 502;
    throw Object.assign(new Error(`OPENAI_ERROR: ${msg}`), { status, details: e1?.response?.data });
  }
}
// ==== generateOutfitsWithAI (END) ====



function buildOutfitFields(outfit, items, meta) {
  const { occasion = '', style = '', weather = '' } = meta;
  const fields = {
    [OUTFITS_NAME_FIELD]: outfit.name,
    [OUTFITS_ITEMS_FIELD]: items.map(i => i.id), // Link field
    [OUTFITS_OCCASION_FIELD]: occasion,
    [OUTFITS_STYLE_FIELD]: style,
    [OUTFITS_WEATHER_FIELD]: weather,
    [OUTFITS_REASON_FIELD]: outfit.reasoning || '',
    [OUTFITS_PALETTE_FIELD]: Array.isArray(outfit.palette) ? outfit.palette.join(', ') : ''
  };

  if (outfit.preview) {
    if (OUTFITS_PHOTO_IS_ATTACHMENT) {
      fields[OUTFITS_PHOTO_FIELD] = [{ url: outfit.preview }];
    } else {
      fields[OUTFITS_PHOTO_FIELD] = outfit.preview;
    }
  }
  return fields;
}

// ---------- ROUTES ----------
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

// List/search clothing items
app.get('/api/closet', requireApiKey, async (req, res, next) => {
  try {
    const { q, limit = 50 } = req.query;
    const cfg = { pageSize: Math.min(Number(limit) || 50, 100) };
    if (q) cfg.filterByFormula = `FIND(LOWER("${String(q).toLowerCase()}"), LOWER({${CLOSET_NAME_FIELD}}))`;
    const records = await tbCloset.select(cfg).all();

    const data = records.map(r => {
      const rawPhoto = readField(r.fields, CLOSET_PHOTO_FIELD, ['Photo','Image URL']);
      const imageUrl = firstUrl(rawPhoto);
      return {
        id: r.id,
        name: readField(r.fields, CLOSET_NAME_FIELD, ['Item Name','Name','Title','Item']),
        category: readField(r.fields, CLOSET_CATEGORY_FIELD, ['Category']),
        brand: readField(r.fields, CLOSET_BRAND_FIELD, ['Brand']),
        color: readField(r.fields, CLOSET_COLOR_FIELD, ['Color','Colors']),
        imageUrl
      };
    });

    res.json({ data });
  } catch (err) { next(err); }
});

// Suggest outfits
app.post('/api/outfits/suggest', requireApiKey, async (req, res, next) => {
  try {
    const parsed = OutfitSuggestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.flatten() } });

    const { occasion, weather, style, itemIds, topK } = parsed.data;
    const items = await fetchClosetItemsByIds(itemIds);
    if (!items.length) return res.status(400).json({ error: { code: 'NO_ITEMS', message: 'Provide valid itemIds' } });

    const outfits = await generateOutfitsWithAI({ items, occasion, weather, style, topK });

    const created = [];
    for (const o of outfits) {
      const fields = buildOutfitFields(o, items, { occasion, style, weather });
      const rec = await tbOutfits.create([{ fields }]);
      created.push({ id: rec[0].id, fields });
    }
    res.status(201).json({ data: created.map(c => ({ id: c.id, ...c.fields })) });
  } catch (err) { next(err); }
});

// Create order
app.post('/api/orders', requireApiKey, async (req, res, next) => {
  try {
    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.flatten() } });

    const { userId, outfitId, fulfillment, note } = parsed.data;
    const outfit = await tbOutfits.find(outfitId).catch(() => null);
    if (!outfit) return res.status(404).json({ error: { code: 'OUTFIT_NOT_FOUND', message: 'Invalid outfitId' } });

    const fields = { 'User Id': userId, Outfit: [outfitId], Status: 'pending', Fulfillment: fulfillment, Note: note || '' };
    const recs = await tbOrders.create([{ fields }]);
    res.status(201).json({ data: { id: recs[0].id, ...fields } });
  } catch (err) { next(err); }
});

// Get order
app.get('/api/orders/:id', requireApiKey, async (req, res, next) => {
  try {
    const rec = await tbOrders.find(req.params.id);
    res.json({ data: { id: rec.id, fields: rec.fields } });
  } catch (err) {
    if (String(err).includes('NOT_FOUND')) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
    next(err);
  }
});

// ---------- ERRORS ----------
/* eslint-disable no-unused-vars */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const payload = {
    code: err.code || 'INTERNAL_ERROR',
    message: err.message || 'Unexpected server error',
    details: err.details,          // <-- surfaces Airtable/OpenAI details
    requestId: req.id
  };
  req.log.error({ err, status, path: req.path, requestId: req.id });
  res.status(status).json({ error: payload });
});
/* eslint-enable no-unused-vars */

// ---------- BOOT ----------
app.listen(PORT, () => {
  console.log(`✅ Outfitted API on ${PORT} (${NODE_ENV})`);
});
