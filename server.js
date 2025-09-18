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

// ---------- PROCESS SAFETY ----------
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED_REJECTION', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT_EXCEPTION', err);
  process.exit(1);
});

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
  OUTFITS_PHOTO_AS_ATTACHMENT = 'true',

  // Optional: bypass OpenAI for debugging
  SKIP_OPENAI = 'false'
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) { console.error('⚠️ Missing Airtable creds'); process.exit(1); }
if (!OPENAI_API_KEY && String(SKIP_OPENAI).toLowerCase() !== 'true') { console.error('⚠️ Missing OPENAI_API_KEY'); process.exit(1); }
if (!API_KEY) { console.error('⚠️ Missing API_KEY'); process.exit(1); }

const CLOSET_PHOTO_IS_ATTACHMENT  = String(CLOSET_PHOTO_AS_ATTACHMENT).toLowerCase() === 'true';
const OUTFITS_PHOTO_IS_ATTACHMENT = String(OUTFITS_PHOTO_AS_ATTACHMENT).toLowerCase() === 'true';

// ---------- CORE ----------
const app = express();
app.set('trust proxy', 1); // behind Render/Cloudflare

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

// ---------- SCHEMAS ----------
const OutfitSuggestSchema = z.object({
  userId: z.string().optional(),
  occasion: z.string().min(1),
  weather: z.string().optional(),
  style: z.string().optional(),
  itemIds: z.array(z.string()).nonempty('Provide itemIds from Clothing Items'),
  topK: z.number().int().min(1).max(5).default(1)
});
const CreateOrderSchema = z.object({
  userId: z.string().min(1),
  outfitId: z.string().min(1),
  fulfillment: z.enum(['delivery','pickup','stylist']).default('delivery'),
  note: z.string().max(2000).optional()
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

app.get('/', (req, res) => {
  res.type('text').send('Outfitted API is running. Try GET /healthz');
});
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

// Suggest outfits (stub when SKIP_OPENAI=true)
app.post('/api/outfits/suggest', requireApiKey, async (req, res, next) => {
  req.log.info('USING_STUB_SUGGEST');
  try {
    const parsed = OutfitSuggestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.flatten() } });
    }

    const { occasion, weather, style, itemIds, topK } = parsed.data;

    const fetchByIds = async (ids) => {
      const out = [];
      for (let i = 0; i < ids.length; i += 10) {
        const batch = ids.slice(i, i + 10);
        const formula = `OR(${batch.map(id => `RECORD_ID() = '${id}'`).join(', ')})`;
        const page = await tbCloset.select({ filterByFormula: formula }).all();
        out.push(...page.map(r => ({ id: r.id, fields: r.fields })));
      }
      return out;
    };

    const items = await fetchByIds(itemIds);
    if (!items.length) {
      return res.status(400).json({ error: { code: 'NO_ITEMS', message: 'Provide valid itemIds' } });
    }

    // If AI is on, call it; else deterministic stub:
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
        [OUTFITS_PALETTE_FIELD]: Array.isArray(o.palette) ? o.palette.join(', ') : ''
      };
      if (o.preview) {
        if (OUTFITS_PHOTO_IS_ATTACHMENT) fields[OUTFITS_PHOTO_FIELD] = [{ url: o.preview }];
        else fields[OUTFITS_PHOTO_FIELD] = o.preview;
      }
      const rec = await tbOutfits.create([{ fields }]);
      created.push({ id: rec[0].id, fields });
    }

    res.status(201).json({ data: created.map(c => ({ id: c.id, ...c.fields })) });
  } catch (err) { next(err); }
});

// ---------- ORDERS (idempotent) ----------
const CreateOrderSchema = z.object({
  userId: z.string().min(1),
  outfitId: z.string().min(1),
  fulfillment: z.enum(['delivery', 'pickup', 'stylist']).default('delivery'),
  note: z.string().max(2000).optional().default(''),
  idempotencyKey: z.string().min(1)
});

// POST /api/orders  (idempotent via Idempotency Key)
app.post('/api/orders', requireApiKey, async (req, res, next) => {
  try {
    const { userId, outfitId, fulfillment, note, idempotencyKey } =
      CreateOrderSchema.parse(req.body);

    // 1) Idempotency check
    const safeKey = String(idempotencyKey).replace(/'/g, "\\'");
    const existing = await tbOrders
      .select({
        maxRecords: 1,
        filterByFormula: `{Idempotency Key} = '${safeKey}'`
      })
      .firstPage();

    if (existing.length) {
      const r = existing[0];
      return res.status(200).json({ data: { id: r.id, ...r.fields } });
    }

    // 2) Validate outfit exists
    const outfit = await tbOutfits.find(outfitId).catch(() => null);
    if (!outfit) {
      return res
        .status(404)
        .json({ error: { code: 'OUTFIT_NOT_FOUND', message: 'Invalid outfitId' } });
    }

    // 3) Create order
    const fields = {
      'User Id': userId,
      'Outfit': [outfitId],            // must be a single linked record field
      'Status': 'pending',
      'Fulfillment': fulfillment,
      'Note': note || '',
      'Idempotency Key': idempotencyKey
    };

    const recs = await tbOrders.create([{ fields }]);
    return res.status(201).json({ data: { id: recs[0].id, ...fields } });
  } catch (err) {
    next(err);
  }
});

// GET /api/orders/:id
app.get('/api/orders/:id', requireApiKey, async (req, res, next) => {
  try {
    const rec = await tbOrders.find(req.params.id);
    res.json({ data: { id: rec.id, ...rec.fields } });
  } catch (err) {
    if (String(err).includes('NOT_FOUND')) {
      return res
        .status(404)
        .json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
    }
    next(err);
  }
});

// ---------- ERROR HANDLER ----------
/* eslint-disable no-unused-vars */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const payload = {
    code: err.code || 'INTERNAL_ERROR',
    message: err.message || 'Unexpected server error',
    details: err.details,
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
