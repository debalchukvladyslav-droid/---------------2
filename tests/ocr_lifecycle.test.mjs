import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../js/ocr.js', import.meta.url), 'utf8');
const scan = source.slice(source.indexOf('async function performOCR('), source.indexOf('async function processOCRQueue('));
function harness({ recognize, saved = 'MSFT' } = {}) {
    const state = { myUserId: 'owner', appData: { tickers: { shot: saved } } };
    let terminated = 0;
    let commits = 0;
    let workers = 0;
    const worker = {
        setParameters: async () => {},
        recognize: async () => recognize ? recognize(state) : { data: { text: 'AAPL', words: [] } },
        terminate: async () => { terminated++; },
    };
    const context = vm.createContext({
        state,
        console: Object.fromEntries(['log', 'warn', 'error', 'groupCollapsed', 'groupEnd'].map(key => [key, () => {}])),
        Image: class { naturalWidth = 1920; naturalHeight = 1080; set src(_value) { this.onload(); } },
        getStorageUrl: async () => 'https://test.invalid/shot.png',
        createTickerOCRWorker: async () => { workers++; return worker; },
        saveToLocal: async () => { commits++; },
        findScreenshotDate: () => '2026-10-13', taggedTickersForPath: () => [],
        normalizeTicker: value => value, TICKER_GARBAGE: new Set(), updateBadgeUI() {},
        isOCRSourceUsable: () => true, unavailableOCRSources: new Set(),
        buildAutoOCRZones: () => [{ label: 'header', phase: 1, h: 50 }],
        ocrVariantPlan: () => ({ scale: 4, variants: [] }), makeOCRVariants: () => [{}, {}],
        scoreTickerCandidates: () => ({ AAPL: 100 }), mergeScores: Object.assign,
        bestTickerFromScores: () => 'AAPL', tickerConfidence: () => ({ ok: true }),
        quickPhaseDecision: () => ({ stop: true, ticker: 'AAPL' }),
        topTickerRows: () => [], logTickerCandidates() {}, OCR_MAX_RAW_TEXT_LOG: 100, OCR_TOP_CANDIDATES_LIMIT: 3,
    });
    vm.runInContext(`${scan}\nglobalThis.run = performOCR;`, context);
    return { state, run: context.run, counts: () => ({ terminated, commits, workers }) };
}

test('a scan reuses one worker across variants and terminates it after saving', async () => {
    const h = harness();
    await h.run('shot', true);
    assert.equal(h.state.appData.tickers.shot, 'AAPL');
    assert.deepEqual(h.counts(), { terminated: 1, commits: 1, workers: 1 });
});

test('an OCR failure preserves a saved ticker and terminates its worker', async () => {
    const h = harness({ recognize: async () => { throw new Error('worker unavailable'); } });
    await h.run('shot', true);
    assert.equal(h.state.appData.tickers.shot, 'MSFT');
    assert.deepEqual(h.counts(), { terminated: 1, commits: 0, workers: 1 });
});

test('an OCR result cannot overwrite another account or a newer manual ticker', async () => {
    for (const switchAccount of [true, false]) {
        const h = harness({ recognize: async state => {
            if (switchAccount) {
                state.myUserId = 'other';
                state.appData = { tickers: { shot: 'NVDA' } };
            } else state.appData.tickers.shot = 'NVDA';
            return { data: { text: 'AAPL', words: [] } };
        } });
        await h.run('shot', true);
        assert.equal(h.state.appData.tickers.shot, 'NVDA');
        assert.deepEqual(h.counts(), { terminated: 1, commits: 0, workers: 1 });
    }
});
