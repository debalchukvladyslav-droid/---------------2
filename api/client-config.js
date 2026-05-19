function pickEnv(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function serviceAccountEmail() {
    const direct = pickEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_CLIENT_EMAIL');
    if (direct) return direct;
    const rawJson = pickEnv('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!rawJson) return '';
    try {
        return JSON.parse(rawJson).client_email || '';
    } catch (_) {
        return '';
    }
}

export default function handler(req, res) {
    const config = {
        supabaseUrl: pickEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'),
        supabaseAnonKey: pickEnv('SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
        telegramBotUsername: pickEnv('TELEGRAM_BOT_USERNAME'),
        telegramLoginReturnBase: pickEnv('TELEGRAM_LOGIN_RETURN_BASE', 'NEXT_PUBLIC_SITE_URL'),
        googleSheetsClientId: pickEnv('GOOGLE_SHEETS_CLIENT_ID'),
        googleSheetsApiKey: pickEnv('GOOGLE_SHEETS_API_KEY'),
        googlePickerAppId: pickEnv('GOOGLE_PICKER_APP_ID', 'GOOGLE_CLOUD_PROJECT_NUMBER'),
        googleDriveClientId: pickEnv('GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_SHEETS_CLIENT_ID'),
        googleServiceAccountEmail: serviceAccountEmail(),
    };

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.status(200).send(`window.TRADING_JOURNAL_CONFIG = ${JSON.stringify(config)};\n`);
}
