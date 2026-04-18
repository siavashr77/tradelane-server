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

// ── MARKET LISTINGS — trim matched first, model fallback ─────────────────────
app.get('/api/listings', async (req, res) => {
  const { vin, key, postal } = req.query;
  if (!vin || !key) return res.status(400).json({ error: 'Missing vin or key' });
  try {
    // First try trim-level match
    const trimUrl = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=15&spec_vin=${vin}&spec_vin_match=trim&postal=${postal || 'M6S3N5'}&radius=200&country=canada`;
    const trimResp = await fetch(trimUrl);
    const trimData = await trimResp.json();

    const trimCount = (trimData.listings || []).length;

    // If trim match returns fewer than 3 listings, fall back to model match
    if (trimCount < 3) {
      const modelUrl = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=15&spec_vin=${vin}&spec_vin_match=model&postal=${postal || 'M6S3N5'}&radius=200&country=canada`;
      const modelResp = await fetch(modelUrl);
      const modelData = await modelResp.json();
      // Flag which match level was used so the UI can show it
      modelData._match_level = 'model';
      modelData._trim_count = trimCount;
      return res.json(modelData);
    }

    trimData._match_level = 'trim';
    trimData._trim_count = trimCount;
    res.json(trimData);
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
