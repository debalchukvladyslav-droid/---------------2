import { supabase } from './supabase.js';

async function currentSession(refresh = false) {
    const result = refresh
        ? await supabase.auth.refreshSession()
        : await supabase.auth.getSession();
    if (result.error) throw result.error;
    return result.data?.session || null;
}

export async function fetchWithSession(url, options = {}) {
    let session = await currentSession(false);
    if (!session?.access_token) session = await currentSession(true);
    if (!session?.access_token) throw Object.assign(new Error('Увійдіть у свій акаунт повторно.'), { status: 401, code: 'AUTH_REQUIRED' });
    const owner = session.user?.id;

    const request = (accessToken) => fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${accessToken}`,
        },
    });

    const response = await request(session.access_token);
    if (response.status !== 401) return response;

    session = await currentSession(true);
    if (!session?.access_token || (owner && session.user?.id !== owner)) return response;
    return request(session.access_token);
}
