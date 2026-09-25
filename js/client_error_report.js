import { supabase } from './supabase.js';

export function syncClientErrorReporter(role) {
    const enabled = role !== 'admin';
    const publish = (accessToken) => {
        window.dispatchEvent(new CustomEvent('tj-error-report', {
            detail: { enabled, token: accessToken || '' },
        }));
    };
    try { sessionStorage.setItem('tj-error-report', enabled ? 'on' : 'off'); } catch { /* Прапорець необов’язковий. */ }
    if (!enabled) {
        publish('');
        return;
    }
    supabase.auth.getSession()
        .then(({ data }) => publish(data?.session?.access_token || ''))
        .catch(() => publish(''));
}
