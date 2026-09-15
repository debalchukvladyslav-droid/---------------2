import { processSourceJobs } from '../../../lib/source_worker.js';

function authorized(header: string, secret: string): boolean {
    if (!secret) return false;
    const expected = `Bearer ${secret}`;
    if (header.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < header.length; i++) difference |= header.charCodeAt(i) ^ expected.charCodeAt(i);
    return difference === 0;
}

Deno.serve((req: Request) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!authorized(req.headers.get('authorization') || '', Deno.env.get('INTEGRATION_WORKER_SECRET') || '')) return new Response('Unauthorized', { status: 401 });
    const task = processSourceJobs().catch((error: Error) => console.error('[integration-worker]', error.message));
    EdgeRuntime.waitUntil(task);
    return Response.json({ ok: true, accepted: true }, { status: 202 });
});
