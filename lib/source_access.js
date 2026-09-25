import { supabaseRest } from './google_sheet_sync.js';

export const SHARED_TRADER_SPREADSHEET_IDS = Object.freeze([
    '1A4sPWQTryHs4QofoM1p0oCaYDWcDM_OPwp3fOQEX4Co',
    '1hw8HRN5w1AhXxrCccMD3dkKHRP86psdRWbKqzG4JXF4',
    '1A91BIhJONSlJNo8RYwL-KUPLupaNMtAtWXQ-kgwEG24',
]);

export function sourceAccessError(message = 'Підключення потребує підтвердження Google або доступу, наданого адміністратором.') {
    return Object.assign(new Error(message), { status: 403, code: 'SOURCE_CONNECTION_REQUIRED' });
}

function cleanSheetOwnerText(value = '') {
    return String(value || '').normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

export function normalizeSheetOwnerTitle(value = '') {
    return cleanSheetOwnerText(value).toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ');
}

function compactSheetOwnerTitle(value = '') {
    return normalizeSheetOwnerTitle(value).replace(/[\s._\-–—()/]+/g, '');
}

function sheetOwnerTokens(value = '') {
    return normalizeSheetOwnerTitle(value).split(/[\s._\-–—()/]+/).filter(Boolean);
}

function sheetOwnerIdentity(profile = {}) {
    return {
        lastName: cleanSheetOwnerText(profile.last_name || profile.ownerSheetTitle || ''),
        firstName: cleanSheetOwnerText(profile.first_name || profile.ownerFirstName || ''),
        nick: cleanSheetOwnerText(profile.nick || profile.ownerNick || ''),
    };
}

export function profileOwnsTraderSheet(profile, sheetTitle) {
    const title = compactSheetOwnerTitle(sheetTitle);
    if (!title) return false;
    const { lastName, firstName, nick } = sheetOwnerIdentity(profile);
    const candidates = [
        lastName,
        [lastName, firstName].filter(Boolean).join(' '),
        [firstName, lastName].filter(Boolean).join(' '),
        nick.length >= 4 ? nick : '',
    ].map(compactSheetOwnerTitle).filter(Boolean);
    if (candidates.includes(title)) return true;
    const surname = compactSheetOwnerTitle(lastName);
    return surname.length >= 4 && sheetOwnerTokens(sheetTitle).includes(surname);
}

export function canBootstrapSharedTraderSheet(profile, spreadsheetId, sheetTitle = '') {
    if (!profile || profile.role === 'admin') return false;
    if (!SHARED_TRADER_SPREADSHEET_IDS.includes(String(spreadsheetId || ''))) return false;
    if (!normalizeSheetOwnerTitle(profile.last_name)) return false;
    if (sheetTitle && !profileOwnsTraderSheet(profile, sheetTitle)) return false;
    return true;
}

export function sheetTitleInRange(range) {
    const value = String(range || '');
    if (!value.includes('!')) return '';
    const separator = value.lastIndexOf('!');
    const rawTitle = value.slice(0, separator);
    return rawTitle.startsWith("'") && rawTitle.endsWith("'") ? rawTitle.slice(1, -1).replace(/''/g, "'") : rawTitle;
}

export function visibleSpreadsheetSheets(sheets, connection) {
    const list = (Array.isArray(sheets) ? sheets : []).filter((sheet) => sheet?.title);
    if (connection?.bootstrap) {
        return list.filter((sheet) => profileOwnsTraderSheet(connection, sheet.title));
    }
    if (connection?.scope) return list.filter((sheet) => sheet.title === connection.scope);
    return list;
}

export function assertBootstrapSheetRange(connection, range, explicitTitle = '') {
    if (!connection?.bootstrap) return String(explicitTitle || connection?.scope || '');
    const inRange = sheetTitleInRange(range);
    const requested = inRange || explicitTitle;
    if (inRange && explicitTitle && normalizeSheetOwnerTitle(inRange) !== normalizeSheetOwnerTitle(explicitTitle)) {
        throw sourceAccessError('Діапазон не належить дозволеному аркушу.');
    }
    if (!profileOwnsTraderSheet(connection, requested)) throw sourceAccessError();
    return inRange || requested;
}

export async function sourceProfile(userId) {
    return (await supabaseRest(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,role,first_name,last_name,nick&limit=1`))?.[0] || {};
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

export async function resolveSheetReadAccess(user, spreadsheetId, { scope = '', connectionId = '' } = {}) {
    try {
        return await resolveSourceConnection(user, 'sheets', spreadsheetId, { scope, connectionId });
    } catch (error) {
        if (error?.code !== 'SOURCE_CONNECTION_REQUIRED') throw error;
        const profile = await sourceProfile(user.id);
        if (!canBootstrapSharedTraderSheet(profile, spreadsheetId, scope)) throw error;
        return {
            user_id: user.id,
            kind: 'sheets',
            resource_id: spreadsheetId,
            scope,
            enabled: true,
            config: {},
            bootstrap: true,
            ownerSheetTitle: String(profile.last_name || '').trim(),
            ownerFirstName: String(profile.first_name || '').trim(),
            ownerNick: String(profile.nick || '').trim(),
        };
    }
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
    const actual = sheetTitleInRange(value);
    if (actual && actual !== title) throw sourceAccessError('Діапазон не належить дозволеному аркушу.');
    return value;
}
