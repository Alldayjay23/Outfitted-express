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
  AIRTABLE_TABLE_CLOSET = 'Closet Items',
  AIRTABLE_TABLE_OUTFITS = 'Outfit Archives',
  AIRTABLE_TABLE_ORDERS = 'Orders',
  OPENAI_API_KEY,
  API_KEY, // simple server-side auth for mobile
  ALLOWED_ORIGINS = ''
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('⚠️ Missing Airtable credentials');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('⚠️ Missing OPENAI_API_KEY');
  process.exit(1);
}
if (!API_KEY) {
  console.error('⚠️ Missing API_KEY for client auth');
  process.exit(1);
}

// ---------- CORE ----------
const app = express();
const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // allow mobile schemes or same-origin/Render health
    if (!origin || allowed.includes(origin) || origin?.startsWith('exp://')) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: false
}));
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

const logger = pinoHttp({
  level: LOG_LEVEL,
  genReqId: (req, res) => req.headers['x-request-id'] || uuidv4(),
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers'],
});
app.use(logger);

const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ---------- AUTH (simple) ----------
function requireApiKey(req, res, next) {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) {
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

// ---------- UTILS ----------
const OutfitSuggestSchema = z.object({
  userId: z.string().optional(),
  occasion: z.string().min(1),
  weather: z.string().optional(),        // e.g., "75F, sunny"
  style: z.string().optional(),          // e.g., "smart casual"
  itemIds: z.array(z.string()).optional(), // Airtable record IDs from Closet Items
  imageUrls: z.array(z.string().url()).optional(), // if you pass direct images
  topK: z.number().int().min(1).max(5).default(3)
});

const CreateOrderSchema = z.object({
  userId: z.string().min(1),
  outfitId: z.string().min(1),
  fulfillment: z.enum(['delivery', 'pickup', 'stylist']).default('delivery'),
  note: z.string().max(2000).optional()
});

// helper: fetch closet items by IDs
async function fetchClosetItemsByIds(ids = []) {
  if (!ids?.length) return [];
  const chunks = [];
  // Airtable allows up to 10 id filters per formula comfortably
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const formula = `OR(${batch.map(id => `RECORD_ID() = '${id}'`).join(', ')})`;
    const page = await tbCloset.select({ filterByFormula: formula }).all();
    chunks.push(...page);
  }
  return chunks.map(r => ({ id: r.id, fields: r.fields }));
}

// helper: minimal OpenAI call (JSON output contract)
async function generateOutfitsWithAI({ items, occasion, weather, style, topK }) {
  const system = `You are a fashion stylist AI. Always return strictly valid JSON matching this schema:
{
  "outfits": [
    {
      "name": "string",
      "items": ["Closet Item Name or ID"],
      "reasoning": "short explanation",
      "palette": ["color1","color2"],
      "preview": "optional image url or empty string"
    }
  ]
}`;
  const user = {
    occasion,
    weather: weather || '',
    style: style || '',
    items: items.map(i => ({
      id: i.id,
      name: i.fields.Name || i.fields.Item || 'Unknown',
      category: i.fields.Category || '',
      color: i.fields.Color || i.fields.Colors || '',
      brand: i.fields.Brand || '',
    })),
    count: topK
  };

  // Ask for compact JSON
  const prompt = `Make ${topK} outfit suggestion(s) from these closet items for the given occasion.
Return ONLY JSON. No prose.

Input:
${JSON.stringify(user, null, 2)}
`;

  // Use Chat Completions for broad compatibility
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = resp.choices?.[0]?.message?.content ?? '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw Object.assign(new Error('AI_JSON_PARSE_ERROR'), { status: 502, details: content?.slice?.(0, 500) });
  }
  if (!parsed?.outfits?.length) {
    throw Object.assign(new Error('AI_EMPTY_OUTFITS'), { status: 502 });
  }
  return parsed.outfits;
}

// ---------- ROUTES ----------
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok', ts: Date.now() }));

// Suggest outfits (replaces Google Form logic)
app.post('/api/outfits/suggest', requireApiKey, async (req, res, next) => {
  try {
    const parsed = OutfitSuggestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.flatten() } });
    }
    const { occasion, weather, style, itemIds = [], topK } = parsed.data;

    const items = await fetchClosetItemsByIds(itemIds);
    if (!items.length) {
      return res.status(400).json({ error: { code: 'NO_ITEMS', message: 'Provide one or more valid itemIds.' } });
    }

    const outfits = await generateOutfitsWithAI({ items, occasion, weather, style, topK });

    // Persist top suggestion(s) to Airtable
    const created = [];
    for (const o of outfits) {
      const fields = {
        Name: o.name,
        Occasion: occasion,
        Style: style || '',
        Weather: weather || '',
        'AI Reasoning': o.reasoning || '',
        'Palette': Array.isArray(o.palette) ? o.palette.join(', ') : '',
        'Preview Image URL': o.preview || '',
        Items: items.map(i => i.id) // link to Closet Items
      };
      const rec = await tbOutfits.create([{ fields }]);
      created.push({ id: rec[0].id, fields });
    }

    return res.status(201).json({
      data: created.map(c => ({ id: c.id, ...c.fields }))
    });
  } catch (err) {
    next(err);
  }
});

// Create an order from an outfit ("Order Now" button)
app.post('/api/orders', requireApiKey, async (req, res, next) => {
  try {
    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: parsed.error.flatten() } });
    }
    const { userId, outfitId, fulfillment, note } = parsed.data;

    // Validate outfit exists
    const outfit = await tbOutfits.find(outfitId).catch(() => null);
    if (!outfit) return res.status(404).json({ error: { code: 'OUTFIT_NOT_FOUND', message: 'Invalid outfitId' } });

    // Create order
    const fields = {
      'User Id': userId,
      Outfit: [outfitId],             // link to Outfit Archives
      Status: 'pending',              // Single select
      Fulfillment: fulfillment,       // Single select
      Note: note || ''
    };
    const recs = await tbOrders.create([{ fields }]);
    const rec = recs[0];

    return res.status(201).json({
      data: { id: rec.id, ...fields }
    });
  } catch (err) {
    next(err);
  }
});

// Get order by id
app.get('/api/orders/:id', requireApiKey, async (req, res, next) => {
  try {
    const rec = await tbOrders.find(req.params.id);
    return res.status(200).json({ data: { id: rec.id, fields: rec.fields } });
  } catch (err) {
    if (String(err).includes('NOT_FOUND')) {
      return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND', message: 'Order not found' } });
    }
    next(err);
  }
});

// ---------- ERROR HANDLER ----------
/* eslint-disable no-unused-vars */
app.use((err, req, res, next) => {
  const status = err.status || 500;
  req.log.error({ err, msg: err.message, status, path: req.path });
  return res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Unexpected server error',
      requestId: req.id
    }
  });
});
/* eslint-enable no-unused-vars */

// ---------- BOOT ----------
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`✅ Outfitted API listening on ${PORT} (${NODE_ENV})`);
});
