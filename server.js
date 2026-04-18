const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve the HTML tool at the root URL
app.use(express.static(path.join(__dirname, 'public')));

// ── MARKET VALUE ─────────────────────────────────────────────────────────────
app.get('/api/marketvalue', async (req, res) => {
  const { vin, key } = req.query;
  if (!vin || !key) return res.status(400).json({ error: 'Missing vin or key' });
  try {
    const url = `https://marketvalue.vinaudit.com/v2/marketvalue?key=${key}&format=json&vin=${vin}&country=canada`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MARKET LISTINGS ───────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  const { vin, key, postal } = req.query;
  if (!vin || !key) return res.status(400).json({ error: 'Missing vin or key' });
  try {
    const url = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=15&spec_vin=${vin}&spec_vin_match=model&postal=${postal || 'M6S3N5'}&radius=200&country=canada`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'TradeLane API server is running ✓' });
});

app.listen(PORT, () => {
  console.log(`TradeLane server running on port ${PORT}`);
});
