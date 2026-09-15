# Незалежні зашифровані копії

Workflow `.github/workflows/offsite-backup.yml` щодня створює узгоджений PostgreSQL archive, копіює всі байти Supabase Storage, перевіряє SHA-256 і записує зашифрований restic snapshot у приватну папку Google Drive. Після першого запуску файли без змін повторно не завантажуються із Supabase. Restic зберігає 30 щоденних і 12 щотижневих snapshot.

У GitHub Actions треба один раз додати secrets:

- `SUPABASE_URL` — URL проєкту.
- `SUPABASE_DB_URL` — direct/session-pooler PostgreSQL URL, доступний з GitHub runner.
- `SUPABASE_SERVICE_ROLE_KEY` — лише для читання Storage і запису статусу копії.
- `RESTIC_PASSWORD` — окремий довгий ключ шифрування. Збережіть його також офлайн: без нього копію відкрити неможливо.
- `RCLONE_CONFIG_B64` — base64 від `rclone.conf` з remote на ім’я `gdrive`, підключеним до приватного Google Drive.

Перед першим schema deploy вручну запустіть workflow і дочекайтеся зеленого кроку `Encrypt, upload, verify, and rotate`. Workflow `monthly-restore-drill.yml` щомісяця розшифровує останню копію, перевіряє кожен файл за маніфестом і транзакційно відновлює базу в окрему локальну Supabase database. GitHub schedule може стартувати із затримкою, тому застосунок позначає копію старшу за 26 годин як проблему.
