// === МІГРАЦІЯ: запустити один раз з консолі браузера ===
// Просто встав весь цей код в консоль і натисни Enter

window.migrateToSubcollections = async function(targetNick) {
    const { db } = await import('./js/firebase.js');
    const { state } = await import('./js/state.js');
    const nick = targetNick || state.USER_DOC_NAME;
    if (!nick) { console.error('Nick не визначено — передай нік вручну: migrateToSubcollections("vlad_stats")'); return; }

    console.log(`⏳ Міграція для: ${nick}`);

    const doc = await db.collection('journal').doc(nick).get();
    if (!doc.exists) { console.error('Документ не знайдено'); return; }

    const raw = doc.data();

    // Збираємо всі дні — підтримуємо обидві старі структури:
    // 1. Дати прямо в корені: { "2026-03-01": {...}, ... }
    // 2. Вкладений journal: { journal: { "2026-03-01": {...} } }
    const byMonth = {};

    const addDay = (dateStr, dayData) => {
        const mk = dateStr.slice(0, 7);
        if (!byMonth[mk]) byMonth[mk] = {};
        byMonth[mk][dateStr] = dayData;
    };

    for (const key in raw) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
            addDay(key, raw[key]);
        } else if (key === 'journal' && raw[key] && typeof raw[key] === 'object') {
            for (const dateStr in raw[key]) {
                if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) addDay(dateStr, raw[key][dateStr]);
            }
        }
    }

    const months = Object.keys(byMonth).sort();
    if (!months.length) { console.warn('⚠️ Днів не знайдено — можливо вже мігровано або дані порожні'); return; }
    console.log(`📅 Знайдено місяців: ${months.length}`, months);

    // Записуємо кожен місяць в сабколекцію
    for (const mk of months) {
        await db.collection('journal').doc(nick).collection('months').doc(mk).set(byMonth[mk]);
        console.log(`✅ ${mk}: ${Object.keys(byMonth[mk]).length} днів`);
    }

    // Очищаємо старі поля з кореневого документа
    // Залишаємо тільки мета-дані
    const KEEP_FIELDS = new Set(['settings', 'errorTypes', 'weeklyComments', 'tickers', 'unassignedImages', 'tradeTypes', 'aiSavedChats', 'playbook', 'screenTags', 'trader_email', 'first_name', 'last_name', 'created_at', 'privateNotes']);
    
    const cleanMeta = {};
    for (const f of KEEP_FIELDS) {
        if (raw[f] !== undefined) cleanMeta[f] = raw[f];
    }

    // Перезаписуємо документ тільки з мета-даними
    await db.collection('journal').doc(nick).set(cleanMeta);
    console.log(`🧹 Корінь очищено, залишено тільки мета-дані`);

    console.log(`🎉 Міграція завершена для ${nick}! Перезавантаж сторінку.`);
};
