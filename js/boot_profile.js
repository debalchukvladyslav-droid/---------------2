export async function loadBootProfile(userId, { read, readCached, cache, online = true }) {
    if (!online) {
        const saved = await readCached(userId, 'boot-profile');
        if (saved?.value?.nick) return { data: saved.value, offline: true };
        throw new Error('Потрібне перше підключення до мережі для цього акаунта.');
    }
    let response;
    try {
        response = await read();
        if (response.error) throw response.error;
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
