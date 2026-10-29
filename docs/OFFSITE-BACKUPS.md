# Незалежні зашифровані копії

Workflow `.github/workflows/offsite-backup.yml` щодня створює узгоджений PostgreSQL archive робочих даних, копіює нові/змінені байти Supabase Storage, перевіряє SHA-256 і записує зашифрований restic snapshot у приватну папку Google Drive. Кеш Storage відновлюється з фактичного абсолютного шляху restic snapshot, тому незмінені файли не скачуються повторно. Restic зберігає 30 щоденних і 12 щотижневих snapshot.

Історія змін і точки відновлення архівуються окремо та поступово через `scripts/archive-recovery.mjs`: dictionary однакових payload, gzip, AES-256-GCM, перевірка читання з Drive. Повні щоденні SQL dump не дублюють ці таблиці, службовий журнал cron та відновлювані ринкові кеші. Робочі журнал, угоди, налаштування, профілі, Auth і реєстр файлів залишаються в регулярному dump. Правила трьох останніх копій та порядок очищення описані в [FREE-TIER-OPERATIONS.md](FREE-TIER-OPERATIONS.md).

Захист трафіку: `BACKUP_STORAGE_DOWNLOAD_BUDGET_BYTES=25000000` обмежує суму нових/змінених файлів
до скачування; пошкоджений маніфест або помилка відновлення кешу зупиняє workflow.
`scripts/check-backup-budget.sql` перед dump перевіряє логічний обсяг робочих рядків
до `BACKUP_DATABASE_LOGICAL_BUDGET_BYTES=20000000`. Це попередня оцінка джерела, не вимірювання billed egress.
Завеликий або початковий набір потребує окремого контрольованого перенесення та перевірки залишку квоти.
Автоматичний процес не підвищує ці бюджети й не позначає незавершену копію як перевірену.

У GitHub Actions треба один раз додати secrets:

- `SUPABASE_URL` — URL проєкту.
- `SUPABASE_DB_URL` — direct/session-pooler PostgreSQL URL, доступний з GitHub runner.
- `SUPABASE_SERVICE_ROLE_KEY` — лише для читання Storage і запису статусу копії.
- `RESTIC_PASSWORD` — окремий довгий ключ шифрування. Збережіть його також офлайн: без нього копію відкрити неможливо.
- `RCLONE_CONFIG_B64` — base64 від `rclone.conf` з remote на ім’я `gdrive`, підключеним до приватного Google Drive.

Перед першим schema deploy вручну запустіть workflow і дочекайтеся зеленого кроку `Encrypt, upload, verify, and rotate`. Workflow `monthly-restore-drill.yml` щомісяця розшифровує останню копію, перевіряє кожен файл за маніфестом і транзакційно відновлює базу в окрему локальну Supabase database. GitHub schedule може стартувати із затримкою, тому застосунок позначає копію старшу за 26 годин як проблему.
