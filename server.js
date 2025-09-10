import 'dotenv/config';
import express from "express";
import cors from "cors";
import Airtable from "airtable";
import fetch from "node-fetch";

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_CLOSET = "Closet Items",
  OPENAI_API_KEY
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID || !OPENAI_API_KEY) {
  console.warn("⚠️ Missing env vars. Add AIRTABLE_API_KEY, AIRTABLE_BASE_ID, AIRTABLE_TABLE_CLOSET, OPENAI_API_KEY in your hosting env.");
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

async function fetchCloset(limit = 200) {
  const records = await base(AIRTABLE_TABLE_CLOSET)
    .select({ maxRecords: limit, view: "Grid view" })
    .all();

  const items = records.map((r) => {
    const f = r.fields || {};
    return {
      id: r.id,
      item_name: f["Item Name"] || "",
      category: f["Category"] || "",
      color: f["Color"] || "",
      photoUrl: Array.isArray(f["Photo"]) && f["Photo"][0]?.url ? f["Photo"][0].url : undefined,
      status: f["Status"] || ""
    };
  });

  return items.filter((i) => (i.status || "Clean").toLowerCase() !== "laundry");
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/outfits", async (req, res) => {
  try {
    const { occasion = "Work", weather = "Mild/Sunny", dare = false } = req.body || {};
    const closet = await fetchCloset(200);
    const closetList = closet.map((c) => ({
      item_name: c.item_name,
      category: c.category,
      color: c.color || ""
    }));

    const dareNote = dare
      ? "\nAdditionally, make Outfit B push the user's style slightly ('Dare'): choose bolder contrast or silhouette while staying occasion-appropriate."
      : "";

    const prompt = `You are a personal stylist.

Here is the user's available (clean) closet inventory (JSON):
${JSON.stringify(closetList, null, 2)}

Task:
- Suggest 2 complete outfits for the occasion: ${occasion} and the weather: ${weather}.
- Each outfit MUST include exactly: 1 Top + 1 Bottom + 1 pair of Shoes. Outerwear is optional (0–1).
- Use ONLY items from the closet list. Do not invent items.
- If an ideal outfit requires something not present, list it under "missing_items".${dareNote}
Return STRICT JSON only with keys: outfit_A, outfit_B, missing_items.`;

    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",          // change to "gpt-4o" or "gpt-3.5-turbo" if needed
        messages: [{ role: "user", content: prompt }],
        temperature: 0.5
      })
    });

    const data = await aiResp.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || "{}";
    const jsonStr = raw.replace(/^```json\s*/i, "").replace(/```$/, "");
    const parsed = JSON.parse(jsonStr);

    // ✅ Normalize anything (array/object/string) into arrays for the UI
    const toArray = (x) => {
      if (Array.isArray(x)) return x;
      if (x && typeof x === "object") return Object.values(x);
      if (typeof x === "string") return [x];
      return [];
    };

    const outfit_A = toArray(parsed.outfit_A).map(String);
    const outfit_B = toArray(parsed.outfit_B).map(String);
    const missing_items = toArray(parsed.missing_items).map(String);

    res.json({ outfit_A, outfit_B, missing_items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Failed to generate outfits" });
  }
});


app.post("/api/gap", async (req, res) => {
  try {
    const { outfit = [] } = req.body || {};
    const closet = await fetchCloset(500);
    const owned = new Set(closet.map((i) => i.item_name.toLowerCase().trim()));
    const missing = outfit.filter((name) => !owned.has(String(name).toLowerCase().trim()));
    res.json({ missing_items: missing });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err?.message || "Failed gap check" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Outfitted server running on http://localhost:${PORT}`));
