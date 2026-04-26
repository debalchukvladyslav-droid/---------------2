const loadedScripts = new Map();

export function loadScriptOnce(src, { async = true, defer = true } = {}) {
    if (loadedScripts.has(src)) return loadedScripts.get(src);

    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
        const promise = new Promise((resolve, reject) => {
            if (existing.dataset.loaded === 'true') {
                resolve();
                return;
            }
            existing.addEventListener('load', () => resolve(), { once: true });
            existing.addEventListener('error', reject, { once: true });
        });
        loadedScripts.set(src, promise);
        return promise;
    }

    const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = async;
        script.defer = defer;
        if (src.includes('cdn.jsdelivr.net')) {
            script.crossOrigin = 'anonymous';
            script.referrerPolicy = 'no-referrer';
        }
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        script.onerror = () => reject(new Error(`Не вдалося завантажити скрипт: ${src}`));
        document.head.appendChild(script);
    });

    loadedScripts.set(src, promise);
    return promise;
}

export async function ensureChartJs() {
    if (!window.Chart) await loadScriptOnce('https://cdn.jsdelivr.net/npm/chart.js');
    if (!window.Chart) throw new Error('Chart.js не завантажився');
    return window.Chart;
}

export async function ensureTesseract() {
    if (!window.Tesseract) await loadScriptOnce('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
    if (!window.Tesseract) throw new Error('Tesseract не завантажився');
    return window.Tesseract;
}

export async function ensureXlsx() {
    if (!window.XLSX) await loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx/dist/xlsx.full.min.js');
    if (!window.XLSX) throw new Error('XLSX не завантажився');
    return window.XLSX;
}

export async function ensureGoogleApi() {
    if (!window.gapi) await loadScriptOnce('https://apis.google.com/js/api.js');
    if (!window.gapi) throw new Error('Google API не завантажився');
    return window.gapi;
}

export async function ensureGoogleIdentity() {
    if (!window.google?.accounts?.oauth2) await loadScriptOnce('https://accounts.google.com/gsi/client');
    if (!window.google?.accounts?.oauth2) throw new Error('Google Sign-In не завантажився');
    return window.google;
}

export async function ensureLightweightCharts() {
    if (!window.LightweightCharts?.createChart) await loadScriptOnce('/lw-charts.js');
    if (!window.LightweightCharts?.createChart) throw new Error('LW Charts не завантажився');
    return window.LightweightCharts;
}
