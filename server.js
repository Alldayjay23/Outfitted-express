// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Airtable from 'airtable';
import fetch from 'node-fetch';

// ---------- ENV ----------
const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_CLOSET, // e.g. "Clothing Items" (matches your Render screenshot)
  OPENAI_API_KEY
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.warn('⚠️ Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️ Missing OPENAI_API_KEY (required for /api/outfits)');
}

// Use your Render value or fallback
const TABLE_NAME = AIRTABLE_TABLE_CLOSET || 'Clothing Items';

// ---------- Airtable ----------
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

async function fetchCloset(limit = 200) {
  const records = await base(TABLE_NAME)
    .select({ maxRecords: limit, view: 'Grid view' })
    .all();

  const items = records.map((r) => {
    const f = r.fields || {};
    return {
      id: r.id,
      item_name: f['Item Name'] || '',
      category: f['Category'] || '',
      color: f['Color'] || '',
      photoUrl: Array.isArray(f['Photo']) && f['Photo'][0]?.url ? f['Photo'][0].url : undefined,
      status: f['Status'] || 'Clean'
    };
  });

  // Only clean items
  return items.filter((i) => String(i.status).toLowerCase() !== 'laundry');
}

// ---------- Express ----------
const app = express();
app.use(cors());
app.use(express.json());

// Health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Closet (thumbnails + meta)
app.get('/api/closet', async (req, res) => {
  try {
    const items = await fetchCloset(200);
    res.json(items);
  } catch (err) {
    console.error('Airtable /api/closet error:', err);
    res.status(500).json({ error: 'Failed to fetch closet' });
  }
});

// Outfits
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
        model: 'gpt-4o-mini', // swap if your account requires
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

    // catalog of thumbnails by item name
    const catalog = Object.fromEntries(
      closet.map((i) => [i.item_name, { photoUrl: i.photoUrl, category: i.category, color: i.color }])
    );

    res.json({ outfit_A, outfit_B, missing_items, catalog });
  } catch (err) {
    console.error('Outfits error:', err);
    res.status(500).json({ error: err?.message || 'Failed to generate outfits' });
  }
});

// Gap check
app.post('/api/gap', async (req, res) => {
  try {
    const { outfit = [] } = req.body || {};
    const closet = await fetchCloset(500);
    const owned = new Set(closet.map((i) => i.item_name.toLowerCase().trim()));
    const missing = outfit.filter((name) => !owned.has(String(name).toLowerCase().trim()));
    res.json({ missing_items: missing });
  } catch (err) {
    console.error('Gap error:', err);
    res.status(500).json({ error: err?.message || 'Failed gap check' });
  }
});

// Debug helper
app.get('/api/debug/closet', async (req, res) => {
  try {
    const items = await fetchCloset(500);
    res.json({ count: items.length, sample: items.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// --- Saved outfits archive from Airtable ---
// requires env AIRTABLE_TABLE_OUTFITS (e.g., "Outfits")
app.get("/api/outfit-archive", async (req, res) => {
  try {
    const tblName = process.env.AIRTABLE_TABLE_OUTFITS;
    if (!tblName) return res.json({ outfits: [] });

    const recs = await base(tblName).select({ view: "Grid view", pageSize: 100 }).all();

    // Build closet map (name -> photo) to help client render thumbnails if you want
    const closet = await fetchCloset(500);
    const catalog = Object.fromEntries(
      closet
        .filter((i) => i.item_name)
        .map((i) => [
          i.item_name,
          { photoUrl: i.photoUrl, category: i.category, color: i.color },
        ])
    );

    const outfits = recs.map((r) => {
      const f = r.fields || {};
      let items = [];
      if (Array.isArray(f.Items)) items = f.Items; // if you used multiselect/array
      else if (typeof f.Items === "string")
        items = f.Items.split(",").map((s) => s.trim()).filter(Boolean);

      const photo =
        Array.isArray(f.Photo) && f.Photo[0]?.url ? f.Photo[0].url : undefined;

      return {
        title: f.Title || r.get("Title") || "",
        items,
        photo,
      };
    });

    res.json({ outfits, catalog });
  } catch (e) {
    console.error("archive error", e);
    res.status(500).json({ error: "Failed to fetch outfits archive" });
  }
});


// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Outfitted server listening on http://localhost:${PORT}`));
