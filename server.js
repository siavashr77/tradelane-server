const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Allow requests from any origin (your testing tool, future website, etc.)
app.use(cors());
app.use(express.json());

// ── MARKET VALUE endpoint ─────────────────────────────────────────────────
// Your tool calls: /api/marketvalue?vin=XXX&key=XXX
app.get('/api/marketvalue', async (req, res) => {
  const { vin, key } = req.query;

  if (!vin || !key) {
    return res.status(400).json({ error: 'Missing vin or key parameter' });
  }

  try {
    const url = `https://marketvalue.vinaudit.com/v2/marketvalue?key=${key}&format=json&vin=${vin}&country=canada`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Market value error:', err.message);
    res.status(500).json({ error: 'Failed to fetch market value: ' + err.message });
  }
});

// ── MARKET LISTINGS endpoint ──────────────────────────────────────────────
// Your tool calls: /api/listings?vin=XXX&key=XXX&postal=XXX
app.get('/api/listings', async (req, res) => {
  const { vin, key, postal } = req.query;

  if (!vin || !key) {
    return res.status(400).json({ error: 'Missing vin or key parameter' });
  }

  try {
    const url = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=15&spec_vin=${vin}&spec_vin_match=model&postal=${postal || 'M6S3N5'}&radius=200&country=canada`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Listings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch listings: ' + err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'TradeLane API server is running ✓' });
});

app.listen(PORT, () => {
  console.log(`TradeLane server running on port ${PORT}`);
});
