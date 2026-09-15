import { supabaseRest } from './google_sheet_sync.js';

export function sourceAccessError(message = 'Підключення потребує підтвердження Google або доступу, наданого адміністратором.') {
    return Object.assign(new Error(message), { status: 403, code: 'SOURCE_CONNECTION_REQUIRED' });
}

export async function sourceProfile(userId) {
    return (await supabaseRest(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,role&limit=1`))?.[0] || {};
}

export async function resolveSourceConnection(user, kind, resourceId, { scope = '', connectionId = '', write = false } = {}) {
    const profile = await sourceProfile(user.id);
    const admin = profile.role === 'admin';
    const filter = connectionId ? `id=eq.${encodeURIComponent(connectionId)}` : `kind=eq.${kind}&resource_id=eq.${encodeURIComponent(resourceId)}`;
    const rows = await supabaseRest(`integration_connections?${filter}&enabled=eq.true&select=*${admin ? '' : `&user_id=eq.${encodeURIComponent(user.id)}`}&order=created_at.asc`);
    const connection = (rows || []).find(row => row.kind === kind && (!resourceId || row.resource_id === resourceId)
        && (kind !== 'sheets' || !scope || !row.scope || row.scope === scope));
    if (!connection) {
        if (admin && resourceId) return { user_id: user.id, kind, resource_id: resourceId, scope, enabled: true, config: {}, admin: true };
        throw sourceAccessError();
    }
    if (write && connection.user_id !== user.id && !admin) throw sourceAccessError('Змінювати підключення може лише власник або адміністратор.');
    return connection;
}

export async function saveVerifiedConnection({ userId, kind, resourceId, scope = '', config = {} }) {
    const rows = await supabaseRest('integration_connections?on_conflict=user_id,kind,resource_id,scope', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({ user_id: userId, kind, resource_id: resourceId, scope, config, enabled: true, verified_at: new Date().toISOString(), next_sync_at: new Date().toISOString() }),
    });
    return rows?.[0];
}

export function assertScopedSheetRange(range, title) {
    const value = String(range || '');
    if (value.includes('!')) {
        const separator = value.lastIndexOf('!');
        const rawTitle = value.slice(0, separator);
        const actual = rawTitle.startsWith("'") && rawTitle.endsWith("'") ? rawTitle.slice(1, -1).replace(/''/g, "'") : rawTitle;
        if (actual !== title) throw sourceAccessError('Діапазон не належить дозволеному аркушу.');
    }
    return value;
}
