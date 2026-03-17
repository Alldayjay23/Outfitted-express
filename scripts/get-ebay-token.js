// scripts/get-ebay-token.js
// Fetches an eBay OAuth 2.0 application token (Client Credentials grant).
//
// Usage:
//   1. Fill in APP_ID and CERT_ID below (eBay Developer portal → Application Keys)
//   2. node scripts/get-ebay-token.js
//   3. Copy the access_token value into EBAY_ACCESS_TOKEN in server.js
//
// Tokens expire after 2 hours — re-run whenever the old one stops working.

const APP_ID  = 'johnatha-Outfitte-PRD-bbf29ee92-d8ce6eaa';
const CERT_ID = 'PRD-bf29ee92b85c-273f-4749-90c3-b2a1';

// ---------------------------------------------------------------------------

const credentials = Buffer.from(`${APP_ID}:${CERT_ID}`).toString('base64');

const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${credentials}`,
    'Content-Type':  'application/x-www-form-urlencoded',
  },
  body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
});

const text = await res.text();

console.log('Status:', res.status, res.statusText);
console.log('Response:');

try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
