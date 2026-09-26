import { state } from './state.js';
import { localDateKey, pickDashQuote } from './dash_quotes_core.js';

export function renderDashQuote() {
    const block = document.getElementById('dash-quote');
    if (!block) return null;
    const tab = document.body?.dataset.mainTab;
    const onDash = tab ? tab === 'dash' : !!document.getElementById('view-dash')?.classList.contains('active');
    if (!onDash) {
        block.hidden = true;
        return null;
    }
    const quote = pickDashQuote({
        userId: state.myUserId || state.USER_DOC_NAME || 'guest',
        date: localDateKey(),
    });
    if (!quote) return null;
    const text = document.getElementById('dash-quote-text');
    const author = document.getElementById('dash-quote-author');
    if (text) text.textContent = quote.text;
    if (author) author.textContent = quote.author;
    block.title = `${quote.text} — ${quote.author}`;
    block.hidden = false;
    return quote;
}
