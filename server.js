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
    // Radius expansion — try progressively wider searches until we find listings
    const radii = [200, 500, 1000, 2000];
    let listings = [];
    let apiMatchLevel = 'trim';
    let usedRadius = 200;
    let trimData = {};

    for (const radius of radii) {
      // Try trim match first
      const trimUrl = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=50&spec_vin=${vin}&spec_vin_match=trim&postal=${postal || 'M6S3N5'}&radius=${radius}&country=canada`;
      const trimResp = await fetch(trimUrl);
      trimData = await trimResp.json();
      listings = trimData.listings || [];
      apiMatchLevel = 'trim';
      usedRadius = radius;

      if (listings.length >= 3) break;

      // Fall back to model match at same radius
      const modelUrl = `https://marketlistings.vinaudit.com/v1/listings?key=${key}&format=json&listing_status=active&page_size=50&spec_vin=${vin}&spec_vin_match=model&postal=${postal || 'M6S3N5'}&radius=${radius}&country=canada`;
      const modelResp = await fetch(modelUrl);
      const modelData = await modelResp.json();
      if ((modelData.listings || []).length > listings.length) {
        listings = modelData.listings || [];
        apiMatchLevel = 'model';
        trimData.pagination = modelData.pagination;
      }

      if (listings.length >= 3) break;
    }

    // No US fallback — US pricing not relevant for Canadian wholesale

    trimData._used_radius = usedRadius;
    trimData._radius_note = usedRadius > 200 ? `Expanded to ${usedRadius}km — limited local supply` : null;

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

    // ── MILEAGE-BANDED AVERAGING ─────────────────────────────────────────────
    // Only average listings within a reasonable mileage range of the subject vehicle
    const subjectKm = parseInt(req.query.mileage) || 0;

    function getListingsWithPriceAndKm(list) {
      // Include listings that have a valid price — km can be 0/missing (handled in banding)
      return list.filter(l => {
        const price = parseFloat(l.listing_price);
        return price > 5000;
      });
    }
    
    function getKm(listing) {
      const km = parseInt(listing.listing_mileage);
      return isNaN(km) ? null : km;
    }

    // KM rates by brand for extrapolation (mirrors frontend logic)
    function getKmRateForMake(make) {
      if (!make) return 0.10;
      const m = make.toLowerCase();
      if (['honda','acura','toyota','lexus','hyundai','mazda','kia','genesis','nissan','subaru','mitsubishi','infiniti'].some(b=>m.includes(b))) return 0.10;
      if (['audi','bmw','mercedes','jaguar','land rover','porsche','maserati','volvo','alfa'].some(b=>m.includes(b))) return 0.25;
      if (['ford','gmc','chevrolet','chevy','cadillac','ram','dodge','chrysler','lincoln','buick'].some(b=>m.includes(b))) return 0.17;
      return 0.10;
    }

    function median(arr) {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0
        ? sorted[mid]
        : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }

    function calcBandedAvg(list, subjectKm, bandKm) {
      const inBand = list.filter(l => {
        const km = getKm(l);
        return km !== null && Math.abs(km - subjectKm) <= bandKm;
      });
      if (!inBand.length) return null;
      // Sort by mileage proximity so closest comps are first
      inBand.sort((a, b) =>
        Math.abs(getKm(a) - subjectKm) -
        Math.abs(getKm(b) - subjectKm)
      );

      // Prefer used listings for median — new car prices inflate the number
      const usedOnly = inBand.filter(l => {
        const t = (l.listing_type || '').toLowerCase();
        return t === 'used' || t === 'certified';
      });
      // Fall back to all listings if fewer than 2 used
      const forMedian = usedOnly.length >= 2 ? usedOnly : inBand;

      const allPrices = inBand.map(l => parseFloat(l.listing_price));
      const medianPrices = forMedian.slice(0, 3).map(l => parseFloat(l.listing_price));

      return {
        avg: Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length),
        median: median(medianPrices),
        low: Math.round(Math.min(...allPrices)),
        high: Math.round(Math.max(...allPrices)),
        count: inBand.length,
        used_count: usedOnly.length,
        band: bandKm,
        closest: forMedian.slice(0, 3).map(l => ({
          price: parseFloat(l.listing_price),
          km: getKm(l),
          type: l.listing_type || '',
          name: [l.vehicle_year, l.vehicle_make, l.vehicle_model, l.vehicle_trim].filter(Boolean).join(' '),
          distance: l.distance || ''
        }))
      };
    }

    // Extrapolate price from nearest comparable using KM rate
    function extrapolateFromNearest(list, subjectKm, make) {
      if (!list.length) return null;
      const rate = getKmRateForMake(make);
      // Sort by mileage proximity to subject vehicle
      // Only extrapolate from listings that have mileage data
      const withKm = list.filter(l => getKm(l) !== null);
      if (!withKm.length) return null;
      const sorted = [...withKm].sort((a, b) => {
        return Math.abs(getKm(a) - subjectKm) - Math.abs(getKm(b) - subjectKm);
      });
      // Use up to 3 nearest by mileage, extrapolate each, then average
      const nearest = sorted.slice(0, 3);
      const extrapolated = nearest.map(l => {
        const listKm = getKm(l);
        const listPrice = parseFloat(l.listing_price);
        const kmDiff = subjectKm - listKm; // negative = subject has fewer km = worth more
        const adjustment = Math.round(kmDiff * rate * -1); // flip sign: fewer km = add value
        return {
          adjustedPrice: Math.round(listPrice + adjustment),
          originalPrice: listPrice,
          listKm,
          kmDiff,
          adjustment
        };
      });
      const adjustedPrices = extrapolated.map(e => e.adjustedPrice);
      return {
        avg: Math.round(adjustedPrices.reduce((a, b) => a + b, 0) / adjustedPrices.length),
        low: Math.round(Math.min(...adjustedPrices)),
        high: Math.round(Math.max(...adjustedPrices)),
        count: nearest.length,
        extrapolated,
        band: null
      };
    }

    const subjectMake = req.query.make || '';
    const validListings = getListingsWithPriceAndKm(filtered);

    // Try progressively wider mileage bands
    let bandResult = null;
    let bandLabel = '';
    let wasExtrapolated = false;

    if (subjectKm > 0) {
      const tight = calcBandedAvg(validListings, subjectKm, 15000);
      if (tight && tight.count >= 2) {
        bandResult = tight;
        bandLabel = `±15,000 km band (${tight.count} listings)`;
      } else {
        const medium = calcBandedAvg(validListings, subjectKm, 30000);
        if (medium && medium.count >= 2) {
          bandResult = medium;
          bandLabel = `±30,000 km band (${medium.count} listings)`;
        } else {
          const wide = calcBandedAvg(validListings, subjectKm, 50000);
          if (wide && wide.count >= 2) {
            bandResult = wide;
            bandLabel = `±50,000 km band (${wide.count} listings)`;
          } else if (validListings.length > 0) {
            // No band matched — extrapolate from nearest comparables using KM rate
            const extResult = extrapolateFromNearest(validListings, subjectKm, subjectMake);
            if (extResult) {
              bandResult = extResult;
              wasExtrapolated = true;
              bandLabel = `Extrapolated from ${extResult.count} nearest listing(s) using $${getKmRateForMake(subjectMake)}/km rate — no close mileage matches found`;
            }
          }
        }
      }
    } else {
      // No mileage provided — use all valid listings
      if (validListings.length > 0) {
        const prices = validListings.map(l => parseFloat(l.listing_price));
        bandResult = {
          avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
          low: Math.round(Math.min(...prices)),
          high: Math.round(Math.max(...prices)),
          count: validListings.length,
          band: null
        };
        bandLabel = 'All listings (no mileage provided)';
      }
    }

    // Return filtered listings with metadata
    trimData.listings = filtered.slice(0, 15);
    trimData._api_match_level = apiMatchLevel;
    trimData._vin_match_level = vinMatchLevel;
    trimData._vin_prefix_used = prefix8;
    trimData._total_before_filter = listings.length;
    trimData._total_after_filter = filtered.length;
    // Debug: log what we found
    console.log(`Listings: total=${listings.length} filtered=${filtered.length} validWithKm=${filtered.filter(l=>getKm&&parseInt(l.listing_mileage)>0).length} subjectKm=${subjectKm} bandResult=${bandResult?bandResult.count:'null'}`);
    trimData._filtered_avg = bandResult ? bandResult.avg : null;
    trimData._filtered_median = bandResult ? bandResult.median : null;
    trimData._filtered_low = bandResult ? bandResult.low : null;
    trimData._filtered_high = bandResult ? bandResult.high : null;
    trimData._filtered_count = bandResult ? bandResult.count : 0;
    trimData._filtered_used_count = bandResult ? (bandResult.used_count || 0) : 0;
    trimData._band_label = bandLabel;
    trimData._closest_comps = bandResult ? bandResult.closest || [] : [];
    trimData._was_extrapolated = wasExtrapolated;

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
