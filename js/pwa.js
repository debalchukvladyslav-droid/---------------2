const DATA_SYNC_PROTOCOL = 2;

function cacheLoadedAssets(worker = navigator.serviceWorker.controller) {
    if (!worker?.postMessage) return;
    const urls = [...new Set((globalThis.performance?.getEntriesByType?.('resource') || []).map((entry) => entry.name))];
    worker.postMessage({ type: 'strum:cache-assets', urls });
}

export function initPwa() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
        navigator.serviceWorker.addEventListener('message', event => {
            if (event.data?.type === 'strum:data-protocol') {
                document.documentElement.dataset.dataProtocol = String(event.data.version);
                if (Number(event.data.version) !== DATA_SYNC_PROTOCOL) location.reload();
            }
        });
        navigator.serviceWorker.addEventListener('controllerchange', () => cacheLoadedAssets());
        const register = () => navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
            .then(async (registration) => {
                await registration.update();
                // Initial scripts predate worker installation, so fetch interception
                // alone cannot make the first successful visit available offline.
                cacheLoadedAssets(registration.active);
            }).catch(error => console.warn('[PWA]', error));
        if (document.readyState === 'complete') void register();
        else window.addEventListener('load', register, { once: true });
    }
    document.documentElement.classList.toggle('is-standalone', window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true);
}
export function initTradeCardGestures(){let startX=0,startY=0,row=null;document.addEventListener('touchstart',event=>{row=event.target.closest('.trade-data-row');if(!row)return;startX=event.touches[0].clientX;startY=event.touches[0].clientY;},{passive:true});document.addEventListener('touchend',event=>{if(!row)return;const dx=event.changedTouches[0].clientX-startX,dy=event.changedTouches[0].clientY-startY;if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)){document.querySelectorAll('.trade-data-row.is-swiped').forEach(item=>item!==row&&item.classList.remove('is-swiped'));row.classList.toggle('is-swiped',dx<0);}row=null;},{passive:true});}
