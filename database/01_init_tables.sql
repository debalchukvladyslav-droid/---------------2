ALTER TABLE profiles ADD COLUMN email TEXT;
ALTER TABLE profiles ADD COLUMN team TEXT;

-- Оновлюємо кеш структури бази (щоб Supabase одразу побачив нові колонки)
NOTIFY pgrst, 'reload schema';

-- Вимикаємо блокування таблиць для розробки
ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
ALTER TABLE journal_days DISABLE ROW LEVEL SECURITY;
ALTER TABLE screenshots DISABLE ROW LEVEL SECURITY;
ALTER TABLE teams DISABLE ROW LEVEL SECURITY;