// === js/supabase.js ===
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'

export const SUPABASE_URL = 'https://gijarvlerztfggxhuvow.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_4gU0201mMkinUqwH-4SkWA_eSoNqew6';

/** Ім’я бота без @ (з @BotFather). Потрібно для віджета «Увійти через Telegram». */
export const TELEGRAM_BOT_USERNAME = 'traderjournalloginbot';

/** Edge Function: після `supabase functions deploy telegram-auth` */
export const TELEGRAM_AUTH_FN = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/telegram-auth`;

// Ініціалізуємо єдину точку доступу до бази, авторизації та сховища
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
