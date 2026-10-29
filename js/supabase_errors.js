// A project restriction affects every endpoint; changing credentials or tables
// cannot recover it. PostgREST errors can contain only a message (no status).
export const SUPABASE_RESTRICTED_MESSAGE = 'Сервіс журналу тимчасово обмежено Supabase через ліміти тарифу або оплату. Зверніться до адміністратора для відновлення доступу.';

export function isSupabaseProjectRestricted(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const description = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ');
    return status === 402
        || /service for this project is restricted|exceed(?:ed)?_(?:db_size|egress|storage_size)_quota/i.test(description);
}
