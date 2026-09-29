import test from 'node:test';
import assert from 'node:assert/strict';
import { chatRecord, floatsForDate, parseShareCount } from '../lib/telegram_float.js';

const kyivMorning = Date.parse('2026-09-28T05:31:00.000Z');

test('group list keeps the title and does not ask to copy a tag', () => {
    assert.deepEqual(chatRecord({
        isGroup: true,
        title: 'Торгівля',
        entity: { className: 'Channel', id: 55, accessHash: '99', username: 'trade_room' },
    }), { key: '@trade_room', title: 'Торгівля (@trade_room)' });
    assert.equal(chatRecord({
        isGroup: true,
        title: 'Без тега',
        entity: { className: 'Channel', id: 55, accessHash: '99' },
    }).key, 'channel:55:99');
    assert.equal(chatRecord({ isUser: true, title: 'Стас', entity: { className: 'User', id: 1 } }), null);
});

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
