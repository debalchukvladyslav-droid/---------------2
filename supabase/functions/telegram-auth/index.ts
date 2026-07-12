import 'jsr:@supabase/functions-js/edge-runtime.d.ts';

const ALLOWED_ORIGINS = new Set([
    'https://traderjournal-six.vercel.app',
    'http://127.0.0.1:8787',
    'http://localhost:8787',
]);

function corsHeaders(req?: Request): Record<string, string> {
    const origin = req?.headers.get('Origin')?.trim() || '';
    return {
        'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin)
            ? origin
            : 'https://traderjournal-six.vercel.app',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
    };
}

function json(body: unknown, status = 410, req?: Request) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
    });
}

Deno.serve((req) => {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    return json({
        ok: false,
        error: 'Telegram login is disabled',
    }, 410, req);
});
