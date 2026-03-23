// scripts/populateStyleData.js
// One-time batch script: generates Style Tags for all closet items missing it.
// Style Tags is an Airtable AI field (plain string write).
// Suggested Outfit Pairing is a read-only Airtable AI field — it auto-generates
// once Style Tags is populated, so we don't write to it directly.
//
// Usage:
//   node scripts/populateStyleData.js

import 'dotenv/config';
import Airtable from 'airtable';
import OpenAI from 'openai';

const {
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE_CLOSET = 'Clothing Items',
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  CLOSET_NAME_FIELD     = 'Item Name',
  CLOSET_CATEGORY_FIELD = 'Category',
  CLOSET_COLOR_FIELD    = 'Color',
} = process.env;

if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('[populate] ERROR: AIRTABLE_API_KEY and AIRTABLE_BASE_ID must be set in .env');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('[populate] ERROR: OPENAI_API_KEY must be set in .env');
  process.exit(1);
}

const base     = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const tbCloset = base(AIRTABLE_TABLE_CLOSET);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

const STYLE_TAGS_FIELD = 'Style Tags';
const DELAY_MS = 500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Airtable AI fields return { state, value, isStale } objects — extract the string value
function aiFieldValue(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && 'value' in raw) return raw.value || '';
  return '';
}

async function generateStyleTags({ name, category, color }) {
  const prompt = `You are a fashion stylist. Given this clothing item, provide:
1. style_tags: 5-8 comma-separated style descriptors (e.g. 'casual, streetwear, relaxed, everyday, neutral')
2. suggested_outfits: 2-3 short outfit pairing suggestions (e.g. 'Pair with slim black jeans and white sneakers for a clean casual look')

Item: ${name}, Category: ${category}, Color: ${color}

Respond ONLY with valid JSON: { "style_tags": "...", "suggested_outfits": "..." }`;

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.7,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = resp.choices?.[0]?.message?.content || '';
  const clean = text.replace(/```json|```/g, '').trim();
  const a = clean.indexOf('{'), b = clean.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error(`Non-JSON response: ${text.slice(0, 200)}`);
  return JSON.parse(clean.slice(a, b + 1));
}

async function main() {
  console.log('[populate] Fetching all closet items from Airtable…');

  const allRecords = await tbCloset.select({ pageSize: 100 }).all();
  console.log(`[populate] Total records found: ${allRecords.length}`);

  // Style Tags is an Airtable AI field — check the nested .value property
  const needsUpdate = allRecords.filter(r => {
    const tagsValue = aiFieldValue(r.fields[STYLE_TAGS_FIELD]);
    return !tagsValue || tagsValue.trim() === '';
  });

  console.log(`[populate] Items needing Style Tags: ${needsUpdate.length} (${allRecords.length - needsUpdate.length} already populated, skipping)`);

  if (needsUpdate.length === 0) {
    console.log('[populate] Nothing to do — all items already have Style Tags.');
    return;
  }

  let done = 0, failed = 0;

  for (let i = 0; i < needsUpdate.length; i++) {
    const r        = needsUpdate[i];
    const name     = r.fields[CLOSET_NAME_FIELD]     || r.fields['Name']  || r.fields['Title'] || 'Unknown';
    const category = r.fields[CLOSET_CATEGORY_FIELD] || '';
    const color    = r.fields[CLOSET_COLOR_FIELD]    || '';
    const label    = `${name} (${category}${color ? ', ' + color : ''})`;

    process.stdout.write(`[populate] item ${i + 1} of ${needsUpdate.length}: ${label} → `);

    try {
      const { style_tags } = await generateStyleTags({ name, category, color });
      const tagsStr = String(style_tags || '').trim();

      await tbCloset.update(r.id, { [STYLE_TAGS_FIELD]: tagsStr }, { typecast: true });

      console.log(`done  [${tagsStr}]`);
      done++;
    } catch (err) {
      console.log(`FAILED — ${err.message}`);
      failed++;
    }

    if (i < needsUpdate.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n[populate] Finished. ${done} updated, ${failed} failed, ${allRecords.length - needsUpdate.length} skipped.`);
  console.log('[populate] Note: Suggested Outfit Pairing is an Airtable AI field — it auto-generates once Style Tags is set.');
}

main().catch(err => {
  console.error('[populate] Fatal error:', err);
  process.exit(1);
});
