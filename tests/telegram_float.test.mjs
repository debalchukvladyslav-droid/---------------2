import test from 'node:test';
import assert from 'node:assert/strict';
import { floatsForDate, parseShareCount } from '../lib/telegram_float.js';

const kyivMorning = Date.parse('2026-09-28T05:31:00.000Z');

test('Valera reply 1.49M on the same day is the float for that ticker', () => {
    assert.equal(parseShareCount('1.49M'), 1_490_000);
    assert.equal(parseShareCount('1,49М'), 1_490_000);
    const floats = floatsForDate([
        { id: 10, date: kyivMorning, text: 'BKYI', fromName: 'Стас' },
        {
            id: 11,
            date: kyivMorning,
            text: '1.49M',
            fromName: 'Валєра 2.0',
            fromUsername: 'Shs_valera_bot',
            replyToId: 10,
        },
        { id: 12, date: kyivMorning, text: 'MSGY', fromName: 'Стас' },
        {
            id: 13,
            date: kyivMorning + 1000,
            text: 'MSGY\n1.49M',
            fromName: 'Валєра 2.0',
            replyToId: 12,
        },
    ], '2026-09-28');
    assert.equal(floats.BKYI, 1_490_000);
    assert.equal(floats.MSGY, 1_490_000);
});

test('a reply from another day or another account is ignored', () => {
    const floats = floatsForDate([
        { id: 1, date: Date.parse('2026-09-27T15:00:00.000Z'), text: 'BKYI', fromName: 'Стас' },
        {
            id: 2,
            date: Date.parse('2026-09-27T15:00:00.000Z'),
            text: '2M',
            fromUsername: 'Shs_valera_bot',
            replyToId: 1,
        },
        { id: 3, date: kyivMorning, text: 'BKYI', fromName: 'Стас' },
        { id: 4, date: kyivMorning, text: '9M', fromName: 'Стас', replyToId: 3 },
    ], '2026-09-28');
    assert.deepEqual(floats, {});
});
