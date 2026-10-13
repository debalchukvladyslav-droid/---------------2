export function isExpiredSessionError(error) {
    return Number(error?.status || error?.statusCode) === 401
        || ['PGRST301', 'PGRST303', 'refresh_token_not_found', 'refresh_token_already_used', 'session_not_found'].includes(error?.code)
        || /JWT expired|invalid JWT|refresh token.*(invalid|not found|expired)/i.test(error?.message || '');
}

export async function loadBootProfile(userId, { read, readCached, cache, refreshSession, online = true }) {
    if (!online) {
        const saved = await readCached(userId, 'boot-profile');
        if (saved?.value?.nick) return { data: saved.value, offline: true };
        throw new Error('Потрібне перше підключення до мережі для цього акаунта.');
    }
    let response;
    try {
        try {
            response = await read();
            if (response.error) throw response.error;
        } catch (error) {
            if (!refreshSession || !isExpiredSessionError(error)) throw error;
            const refreshed = await refreshSession();
            if (refreshed?.error) throw refreshed.error;
            if (refreshed?.data?.session?.user?.id !== userId) {
                throw Object.assign(new Error('Сесія змінилась. Увійдіть у свій акаунт повторно.'), { status: 401 });
            }
            response = await read();
            if (response.error) throw response.error;
        }
    } catch (error) {
        const status = Number(error.status || error.statusCode || 0);
        const transient = status >= 500 || status === 408 || (!status && /fetch|network|timeout|timed out|вчасно|з’єднання/i.test(error.message || ''));
        if (transient) {
            const saved = await readCached(userId, 'boot-profile');
            if (saved?.value?.nick) return { data: saved.value, offline: true };
        }
        throw error;
    }
    // Transport errors are not evidence of an unapproved/missing account.
    if (response.error) throw response.error;
    if (response.data?.nick) {
        const { nick, role, mentor_enabled, settings = {} } = response.data;
        await cache(userId, 'boot-profile', { nick, role, mentor_enabled, settings: {
            account_approved: settings.account_approved, account_blocked: settings.account_blocked, auth_provider: settings.auth_provider,
        } });
    }
    return response;
}
