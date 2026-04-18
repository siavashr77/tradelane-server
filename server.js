const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MARKET VALUE ──────────────────────────────────────────────────────────────
app.get('/api/marketvalue', async (req, res) => {
  const { vin, key } = req.query;
  if (!vin || !key) return res.status(400).json({ error: 'Missing vin or key' });
  try {
    const trimUrl = `https://marketvalue.vinaudit.com/v2/marketvalue?key=${key}&format=json&vin=${vin}&country=canada&spec_vin_match=trim`;
    const trimResp = await fetch(trimUrl);
    const trimData = await trimResp.json();
    const trimCount = parseInt(trimData.count) || 0;
    if (trimData.success && trimCount >= 10 && parseFloat(trimData.prices?.average || 0) > 0) {
      trimData._match_level = 'trim';
      trimData._sample_count = trimCount;
      return res.json(trimData);
    }
    const modelUrl = `https://marketvalue.vinaudit.com/v2/marketvalue?key=${key}&format=json&vin=${vin}&country=canada`;
    const modelResp = await fetch(modelUrl);
    const modelData = await modelResp.json();
    modelData._match_level = 'model';
    modelData._sample_count = parseInt(modelData.count) || 0;
    res.json(modelData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── MARKET LISTINGS — VIN prefix filtered ────────────────────────────────────
app.get('/api/listings', async (req, res) => {
  const { vin, key, postal } = req.query;
  if (!vin || !key) return res.status(400).json({ error: 'Missing vin or key' });

  try {
    // Fetch trim-matched listings first, fall back to model
    const trimUrl = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=50&spec_vin=${vin}&spec_vin_match=trim&postal=${postal || 'M6S3N5'}&radius=200&country=canada`;
    const trimResp = await fetch(trimUrl);
    const trimData = await trimResp.json();
    let listings = trimData.listings || [];
    let apiMatchLevel = 'trim';

    if (listings.length < 3) {
      const modelUrl = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=50&spec_vin=${vin}&spec_vin_match=model&postal=${postal || 'M6S3N5'}&radius=200&country=canada`;
      const modelResp = await fetch(modelUrl);
      const modelData = await modelResp.json();
      listings = modelData.listings || [];
      apiMatchLevel = 'model';
      trimData.pagination = modelData.pagination;
    }

    // Deduplicate by VIN
    const seen = new Set();
    listings = listings.filter(l => {
      const v = (l.vin || '').toString().trim().replace(/\s/g, '');
      if (!v || seen.has(v)) return false;
      seen.add(v);
      return true;
    });

    // ── VIN PREFIX FILTERING ──────────────────────────────────────────────────
    // Extract VIN prefix levels from the subject VIN
    const cleanVin = vin.trim().replace(/\s/g, '');
    const prefix8 = cleanVin.substring(0, 8);  // Most precise: country+mfr+vehicle line+series+body+engine
    const prefix5 = cleanVin.substring(0, 5);  // Mid: country+mfr+vehicle line+series
    const prefix3 = cleanVin.substring(0, 3);  // Broad: country+mfr+vehicle type
    const prefix1 = cleanVin.substring(0, 1);  // Minimum: country of manufacture only

    function filterByPrefix(list, prefix) {
      return list.filter(l => {
        const lv = (l.vin || '').toString().trim().replace(/\s/g, '');
        return lv.length === 17 && lv.substring(0, prefix.length) === prefix;
      });
    }

    // Try progressively looser filters until we have enough listings
    let filtered = filterByPrefix(listings, prefix8);
    let vinMatchLevel = 'positions 1-8 (most precise)';

    if (filtered.length < 3) {
      filtered = filterByPrefix(listings, prefix5);
      vinMatchLevel = 'positions 1-5';
    }
    if (filtered.length < 3) {
      filtered = filterByPrefix(listings, prefix3);
      vinMatchLevel = 'positions 1-3 (manufacturer)';
    }
    if (filtered.length < 3) {
      filtered = filterByPrefix(listings, prefix1);
      vinMatchLevel = 'position 1 (country only)';
    }
    if (filtered.length < 3) {
      filtered = listings; // no VIN filter possible
      vinMatchLevel = 'none (insufficient VIN matches)';
    }

    // Calculate filtered market average from listing prices
    const validPrices = filtered
      .filter(l => parseFloat(l.listing_price) > 5000)
      .map(l => parseFloat(l.listing_price));

    const filteredAvg = validPrices.length
      ? Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length)
      : null;

    const filteredLow = validPrices.length ? Math.round(Math.min(...validPrices)) : null;
    const filteredHigh = validPrices.length ? Math.round(Math.max(...validPrices)) : null;

    // Return filtered listings with metadata
    trimData.listings = filtered.slice(0, 15); // cap at 15 for display
    trimData._api_match_level = apiMatchLevel;
    trimData._vin_match_level = vinMatchLevel;
    trimData._vin_prefix_used = prefix8;
    trimData._total_before_filter = listings.length;
    trimData._total_after_filter = filtered.length;
    trimData._filtered_avg = filteredAvg;
    trimData._filtered_low = filteredLow;
    trimData._filtered_high = filteredHigh;

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
