export function normalizeBrokerTradeType(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const key = raw.toLowerCase().replace(/[^a-zа-яіїєґ0-9]+/gi, '');
    if (/(^|[^a-z])short/.test(raw.toLowerCase()) || key.includes('шорт')) return 'Short';
    if (/(^|[^a-z])long/.test(raw.toLowerCase()) || key.includes('лонг')) return 'Long';
    return raw;
}
