// ─── Live FX rate: NGN → USD ──────────────────────────────────────────────────
//
// Fetches from NGN_USD_RATE_API (ExchangeRate-API format).
// The free tier allows 1,500 requests/month — cached for 1 hour to stay safe.
//
// ExchangeRate-API response shape (base USD):
//   { "base_code": "USD", "conversion_rates": { "NGN": 1540.5, ... } }
//
// NGN→USD = 1 / conversion_rates.NGN

const FALLBACK_RATE = 0.00065; // ≈ 1540 NGN/USD — used when API is unavailable
const CACHE_TTL_MS  = 60 * 60 * 1000; // 1 hour

let _cachedRate: number | null = null;
let _cacheExpiry               = 0;

export async function getNgnToUsdRate(): Promise<number> {
  // Return cached rate if still fresh
  if (_cachedRate !== null && Date.now() < _cacheExpiry) {
    return _cachedRate;
  }

  const apiUrl = process.env.NGN_USD_RATE_API;
  if (!apiUrl) {
    console.warn("[fx] NGN_USD_RATE_API not set — using fallback rate");
    return FALLBACK_RATE;
  }

  try {
    const res  = await fetch(apiUrl, { signal: AbortSignal.timeout(8_000) });
    const data = await res.json() as { result?: string; conversion_rates?: Record<string, number> };

    if (data.result !== "success" || !data.conversion_rates?.NGN) {
      console.warn("[fx] Unexpected API response — using fallback rate", data);
      return FALLBACK_RATE;
    }

    const ngnPerUsd = data.conversion_rates.NGN;
    _cachedRate  = 1 / ngnPerUsd;
    _cacheExpiry = Date.now() + CACHE_TTL_MS;

    console.info({ ngnPerUsd, usdPerNgn: _cachedRate }, "[fx] Rate refreshed");
    return _cachedRate;
  } catch (err: any) {
    console.error({ err: err.message }, "[fx] Failed to fetch rate — using fallback");
    return FALLBACK_RATE;
  }
}

export function ngnToUsd(amountNgn: number, rate: number): number {
  return parseFloat((amountNgn * rate).toFixed(6));
}
