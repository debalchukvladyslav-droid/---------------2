export const NYSE_CALENDAR_SOURCE = 'https://www.nyse.com/trade/hours-calendars';

const OFFICIAL_EARLY_CLOSES = new Map([
    ['2025-07-03', 'Перед Днем незалежності'],
    ['2025-11-28', 'День після Дня подяки'],
    ['2025-12-24', 'Переддень Різдва'],
    ['2026-11-27', 'День після Дня подяки'],
    ['2026-12-24', 'Переддень Різдва'],
    ['2027-11-26', 'День після Дня подяки'],
    ['2028-07-03', 'Перед Днем незалежності'],
    ['2028-11-24', 'День після Дня подяки'],
]);

function isoDate(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function utcDate(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day));
}

function dateIso(date) {
    return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function nthWeekday(year, month, weekday, nth) {
    const date = utcDate(year, month, 1);
    date.setUTCDate(1 + ((7 + weekday - date.getUTCDay()) % 7) + (nth - 1) * 7);
    return dateIso(date);
}

function lastWeekday(year, month, weekday) {
    const date = utcDate(year, month + 1, 0);
    date.setUTCDate(date.getUTCDate() - ((7 + date.getUTCDay() - weekday) % 7));
    return dateIso(date);
}

function observedFixedHoliday(year, month, day, saturdayObserved = true) {
    const date = utcDate(year, month, day);
    if (date.getUTCDay() === 6) {
        if (!saturdayObserved) return '';
        date.setUTCDate(date.getUTCDate() - 1);
    } else if (date.getUTCDay() === 0) {
        date.setUTCDate(date.getUTCDate() + 1);
    }
    return dateIso(date);
}

// Anonymous Gregorian computus.
function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return utcDate(year, month, day);
}

function nyseHolidays(year) {
    const holidays = new Map();
    const add = (date, name) => { if (date) holidays.set(date, name); };

    // NYSE does not move New Year's Day to Friday when January 1 falls on Saturday.
    add(observedFixedHoliday(year, 1, 1, false), 'Новий рік');
    add(nthWeekday(year, 1, 1, 3), 'День Мартіна Лютера Кінга');
    add(nthWeekday(year, 2, 1, 3), 'День президентів США');
    const goodFriday = easterSunday(year);
    goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
    add(dateIso(goodFriday), 'Страсна п’ятниця');
    add(lastWeekday(year, 5, 1), 'День пам’яті');
    if (year >= 2022) add(observedFixedHoliday(year, 6, 19), 'Juneteenth');
    add(observedFixedHoliday(year, 7, 4), 'День незалежності США');
    add(nthWeekday(year, 9, 1, 1), 'День праці США');
    add(nthWeekday(year, 11, 4, 4), 'День подяки');
    add(observedFixedHoliday(year, 12, 25), 'Різдво');
    return holidays;
}

export function getNyseDaySchedule(dateStr) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const holiday = nyseHolidays(year).get(dateStr);
    if (holiday) {
        return { type: 'closed', name: holiday, message: `NYSE зачинена: ${holiday}` };
    }
    const earlyClose = OFFICIAL_EARLY_CLOSES.get(dateStr);
    if (earlyClose) {
        return {
            type: 'early-close',
            name: earlyClose,
            closeTime: '13:00 ET',
            message: `Скорочений день до 13:00 ET: ${earlyClose}`,
        };
    }
    return null;
}

