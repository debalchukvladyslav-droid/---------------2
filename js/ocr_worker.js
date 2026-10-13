import { ensureTesseract } from './vendor_loader.js';

// Keep the worker, core and language data on the site's own origin. A CDN
// outage must not stop OCR after the main Tesseract script has loaded.
export async function createTickerOCRWorker({ load = ensureTesseract, origin = globalThis.location?.origin } = {}) {
    const engine = await load();
    const base = new URL('/vendor/tesseract/', origin).href;
    return engine.createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: base,
        langPath: `${base}lang`,
        workerBlobURL: false,
    });
}
