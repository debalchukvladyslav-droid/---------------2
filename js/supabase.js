// === js/supabase.js ===
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const appConfig = window.TRADING_JOURNAL_CONFIG || {};

function requiredConfig(name) {
    const value = appConfig[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new Error(`Missing ${name} in config.js. Copy config.example.js to config.js and fill it in.`);
}

export const SUPABASE_URL = requiredConfig('supabaseUrl').replace(/\/$/, '');
export const SUPABASE_ANON_KEY = requiredConfig('supabaseAnonKey');

/** Bot username without @. Must match the bot used by the Telegram webhook. */
export const TELEGRAM_BOT_USERNAME = String(appConfig.telegramBotUsername || '').trim();

/** Edge Function URL after `supabase functions deploy telegram-auth`. */
export const TELEGRAM_AUTH_FN = `${SUPABASE_URL}/functions/v1/telegram-auth`;

/**
 * Base URL for the "Open journal" button after Telegram login.
 * Empty value falls back to the current browser origin.
 */
export const TELEGRAM_LOGIN_RETURN_BASE = String(appConfig.telegramLoginReturnBase || '').trim();

// Single access point for database, auth, and storage.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
