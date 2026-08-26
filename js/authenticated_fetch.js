import { supabase } from './supabase.js';

async function currentAccessToken(refresh = false) {
    const result = refresh
        ? await supabase.auth.refreshSession()
        : await supabase.auth.getSession();
    if (result.error) throw result.error;
    return result.data?.session?.access_token || '';
}

export async function fetchWithSession(url, options = {}) {
    let token = await currentAccessToken(false);
    if (!token) token = await currentAccessToken(true);
    if (!token) throw new Error('Active session required');

    const request = (accessToken) => fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${accessToken}`,
        },
    });

    let response = await request(token);
    if (response.status !== 401) return response;

    token = await currentAccessToken(true);
    return token ? request(token) : response;
}
