import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalEmailContent, sendApprovalEmail } from '../lib/registration_requests.js';

test('approval email tells the user the account was accepted', () => {
    const content = approvalEmailContent({
        first_name: 'Олена',
        last_name: 'Коваль',
        email: 'olena@example.com',
    }, 'https://traderjournal-six.vercel.app');
    assert.equal(content.subject, 'Ваш акаунт схвалено');
    assert.match(content.html, /Привіт, Олена Коваль!/);
    assert.match(content.html, /схвалив вашу заявку/);
    assert.match(content.html, /href="https:\/\/traderjournal-six\.vercel\.app"/);
});

test('approval email is sent to the registrant through Resend', async () => {
    const previousKey = process.env.RESEND_API_KEY;
    const previousFrom = process.env.REGISTRATION_EMAIL_FROM;
    process.env.RESEND_API_KEY = 're_test';
    process.env.REGISTRATION_EMAIL_FROM = 'Trading Journal <journal@example.com>';
    let captured = null;
    try {
        const result = await sendApprovalEmail({
            id: 'user-1',
            email: 'olena@example.com',
            nick: 'olena',
            settings: {},
        }, {
            fetchImpl: async (url, options) => {
                captured = { url, options };
                return { ok: true, text: async () => '' };
            },
        });
        assert.equal(result.sent, true);
        assert.equal(captured.url, 'https://api.resend.com/emails');
        const body = JSON.parse(captured.options.body);
        assert.deepEqual(body.to, ['olena@example.com']);
        assert.equal(body.subject, 'Ваш акаунт схвалено');
        assert.equal(captured.options.headers['Idempotency-Key'], 'registration-approved-user-1');
    } finally {
        if (previousKey === undefined) delete process.env.RESEND_API_KEY;
        else process.env.RESEND_API_KEY = previousKey;
        if (previousFrom === undefined) delete process.env.REGISTRATION_EMAIL_FROM;
        else process.env.REGISTRATION_EMAIL_FROM = previousFrom;
    }
});

test('approval email is not sent again after it was already delivered', async () => {
    let called = false;
    const result = await sendApprovalEmail({
        id: 'user-1',
        email: 'olena@example.com',
        settings: { registration_request: { approval_notified_at: '2026-09-24T00:00:00.000Z' } },
    }, {
        fetchImpl: async () => {
            called = true;
            return { ok: true, text: async () => '' };
        },
    });
    assert.equal(result.sent, true);
    assert.equal(called, false);
});
