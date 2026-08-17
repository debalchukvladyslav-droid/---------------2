import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAtr, calculateRelativeVolume, clearMarketEnrichmentCache, enrichMarketData, normalizeTicker } from '../lib/market_enrichment.js';

test('ticker validation is strict and normalized', () => { assert.equal(normalizeTicker(' aapl '), 'AAPL'); assert.equal(normalizeTicker('../AAPL'), ''); assert.equal(normalizeTicker(''), ''); });

test('ATR and RVOL use historical bars without inventing values', () => {
    const bars = Array.from({ length: 16 }, (_, index) => ({ h: 11 + index, l: 9 + index, c: 10 + index, v: 1000 }));
    assert.equal(calculateAtr(bars), 2); assert.equal(calculateRelativeVolume(2500, bars), 2.5); assert.equal(calculateRelativeVolume(null, bars), null);
});

test('hybrid enrichment maps provider data and caches it', async () => {
    clearMarketEnrichmentCache(); let calls = 0;
    const bars = Array.from({ length: 16 }, (_, index) => ({ h: 11 + index, l: 9 + index, c: 10 + index, v: 1000 }));
    const fetchImpl = async (url) => { calls += 1; const value = String(url); const body = value.includes('/quote') ? { c: 12, o: 11, pc: 10, v: 2500 } : value.includes('/profile2') ? { ticker: 'XYZ', shareOutstanding: 12.5 } : value.includes('/metric') ? { metric: {} } : { results: bars }; return { ok: true, status: 200, json: async () => body }; };
    const options = { fetchImpl, environment: { FINNHUB_API_KEY: 'f', POLYGON_API_KEY: 'p' } };
    const result = await enrichMarketData('xyz', options);
    assert.deepEqual({ gap: result.gapPct, rvol: result.rvol, float: result.floatShares, atr: result.atr }, { gap: 10, rvol: 2.5, float: 12500000, atr: 2 });
    assert.equal(result.provider, 'Finnhub + Polygon'); const cached = await enrichMarketData('XYZ', options); assert.equal(cached.cached, true); assert.equal(calls, 4);
});

test('not-found, rate-limit, and invalid ticker errors stay actionable', async () => {
    clearMarketEnrichmentCache(); const response = (status) => async () => ({ ok: false, status, json: async () => ({ message: 'provider rejected' }) });
    await assert.rejects(() => enrichMarketData('XYZ', { fetchImpl: response(404), environment: { FINNHUB_API_KEY: 'f' }, skipCache: true }), (error) => error.code === 'TICKER_NOT_FOUND');
    await assert.rejects(() => enrichMarketData('XYZ', { fetchImpl: response(429), environment: { POLYGON_API_KEY: 'p' }, skipCache: true }), (error) => error.code === 'MARKET_RATE_LIMITED');
    await assert.rejects(() => enrichMarketData('bad ticker!', { environment: {} }), (error) => error.code === 'INVALID_TICKER');
});
