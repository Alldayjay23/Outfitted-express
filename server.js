// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Airtable from 'airtable';
import fetch from 'node-fetch';

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_CLOSET,      // e.g. "Clothing Items"
  AIRTABLE_TABLE_OUTFITS,     // e.g. "Outfits"
  OPENAI_API_KEY
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.warn('⚠️ Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️ Missing OPENAI_API_KEY (required for /api/outfits)');
}

const TABLE_CLOSET = AIRTABLE_TABLE_CLOSET || 'Clothing Items';
const TABLE_OUTFITS = AIRTABLE_TABLE_OUTFITS || null;

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

async function fetchCloset(limit = 200) {
  const records = await base(TABLE_CLOSET)
    .select({ maxRecords: limit, view: 'Grid view' })
    .all();

  const items = records.map((r) => {
    const f = r.fields || {};
    return {
      id: r.id,
      item_name: f['Item Name'] || '',
      category: f['Category'] || '',
      color: f['Color'] || '',
      photoUrl:
        Array.isArray(f['Photo']) && f['Photo'][0]?.url ? f['Photo'][0].url : undefined,
      status: f['Status'] || 'Clean'
    };
  });

  // Only clean items
  return items.filter((i) => String(i.status).toLowerCase() !== 'laundry');
}

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/debug/env', (req, res) => {
  // safe peek to help debugging (doesn't leak secrets)
  res.json({
    baseId: AIRTABLE_BASE_ID?.slice(0, 6) + '…',
    tables: {
      closet: TABLE_CLOSET,
      outfits: TABLE_OUTFITS
    }
  });
});

app.get('/api/closet', async (req, res) => {
  try {
    const items = await fetchCloset(200);
    res.json(items);
  } catch (err) {
    console.error('Airtable /api/closet error:', err?.statusCode, err?.error, err?.message);
    res.status(500).json({ error: 'Failed to fetch closet' });
  }
});

app.post('/api/outfits', async (req, res) => {
  try {
    const { occasion = 'Work', weather = 'Mild/Sunny', dare = false } = req.body || {};
    const closet = await fetchCloset(200);
    const closetList = closet.map((c) => ({
      item_name: c.item_name,
      category: c.category,
      color: c.color || ''
    }));

    const dareNote = dare
      ? "\nAdditionally, make Outfit B push the user's style slightly ('Dare'): choose bolder contrast or silhouette while staying occasion-appropriate."
      : '';

    const prompt = `You are a personal stylist.

Here is the user's available (clean) closet inventory (JSON):
${JSON.stringify(closetList, null, 2)}

Task:
- Suggest 2 complete outfits for the occasion: ${occasion} and the weather: ${weather}.
- Each outfit MUST include exactly: 1 Top + 1 Bottom + 1 pair of Shoes. Outerwear is optional (0–1).
- Use ONLY items from the closet list. Do not invent items.
- If an ideal outfit requires something not present, list it under "missing_items".${dareNote}
Return STRICT JSON only with keys: outfit_A, outfit_B, missing_items.`;

    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5
      })
    });

    const data = await aiResp.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '{}';
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```$/, '');
    const parsed = JSON.parse(jsonStr);

    const toArray = (x) => (Array.isArray(x) ? x : x ? [x].flat() : []);
    const outfit_A = toArray(parsed.outfit_A).map(String);
    const outfit_B = toArray(parsed.outfit_B).map(String);
    const missing_items = toArray(parsed.missing_items).map(String);

    const catalog = Object.fromEntries(
      closet.map((i) => [i.item_name, { photoUrl: i.photoUrl, category: i.category, color: i.color }])
    );

    res.json({ outfit_A, outfit_B, missing_items, catalog });
  } catch (err) {
    console.error('Outfits error:', err?.statusCode, err?.error, err?.message);
    res.status(500).json({ error: err?.message || 'Failed to generate outfits' });
  }
});

app.post('/api/gap', async (req, res) => {
  try {
    const { outfit = [] } = req.body || {};
    const closet = await fetchCloset(500);
    const owned = new Set(closet.map((i) => i.item_name.toLowerCase().trim()));
    const missing = outfit.filter((name) => !owned.has(String(name).toLowerCase().trim()));
    res.json({ missing_items: missing });
  } catch (err) {
    console.error('Gap error:', err?.statusCode, err?.error, err?.message);
    res.status(500).json({ error: err?.message || 'Failed gap check' });
  }
});

// ---- Outfits archive ----
app.get('/api/outfit-archive', async (req, res) => {
  try {
    if (!TABLE_OUTFITS) return res.json({ outfits: [], catalog: {} });

    const recs = await base(TABLE_OUTFITS).select({ view: 'Grid view', pageSize: 100 }).all();

    const closet = await fetchCloset(500);
    const catalog = Object.fromEntries(
      closet
        .filter((i) => i.item_name)
        .map((i) => [i.item_name, { photoUrl: i.photoUrl, category: i.category, color: i.color }])
    );

    const outfits = recs.map((r) => {
      const f = r.fields || {};
      let items = [];
      if (Array.isArray(f.Items)) items = f.Items;
      else if (typeof f.Items === 'string')
        items = f.Items.split(',').map((s) => s.trim()).filter(Boolean);

      const photo =
        Array.isArray(f.Photo) && f.Photo[0]?.url ? f.Photo[0].url : undefined;

      return {
        title: f.Title || r.get('Title') || '',
        items,
        photo
      };
    });

    res.json({ outfits, catalog });
  } catch (e) {
    console.error('archive error', e?.statusCode, e?.error, e?.message);
    // Add a friendlier message on common cases
    if (e?.statusCode === 403) {
      return res.status(403).json({
        error:
          'Airtable denied access (403). Check your PAT scopes (data.records:read) and that it has access to this base, and verify AIRTABLE_BASE_ID points to the base that contains the "Outfits" table.'
      });
    }
    if (e?.statusCode === 404) {
      return res.status(404).json({
        error:
          'Table not found. Confirm AIRTABLE_TABLE_OUTFITS matches the table name exactly in Airtable.'
      });
    }
    res.status(500).json({ error: 'Failed to fetch outfits archive' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Outfitted server listening on http://localhost:${PORT}`));
