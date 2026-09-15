# Розгортання надійного збереження

Цей порядок не можна переставляти: перша незалежна копія має бути перевірена до зміни production-схеми. Старий клієнт після міграції втрачає право прямого запису в основні таблиці, тому frontend, SQL та Edge Function розгортаються одним контрольованим релізом.

## 1. Одноразова підготовка копій

1. Додайте GitHub Actions secrets з [OFFSITE-BACKUPS.md](./OFFSITE-BACKUPS.md).
2. Збережіть `RESTIC_PASSWORD` окремо від GitHub і Google Drive, бажано у двох фізично незалежних місцях.
3. Запустіть workflow **Encrypted offsite backup** вручну.
4. Продовжуйте лише після успішних кроків `Download changed Storage objects and verify checksums` і `Encrypt, upload, verify, and rotate`.
5. Запустіть **Monthly restore drill** вручну. Перевірка повинна відновити PostgreSQL в окрему базу та звірити SHA-256 дампа і всіх файлів.

Дамп зберігає власників і SQL-права доступу. Ізольована репетиція поки використовує `--no-owner --no-privileges`, тому перевіряє відновлення схеми й даних, але не підтверджує відновлення прав. Перед production-перенесенням треба окремо відновити необхідні ролі та перевірити доступ від `anon`, `authenticated` і `service_role`. Сам факт проходження локальних тестів не замінює цю репетицію.

## 2. Секрети Google worker

Edge Function `integration-worker` використовує стандартні `SUPABASE_URL` і `SUPABASE_SERVICE_ROLE_KEY`, а також:

- `INTEGRATION_WORKER_SECRET` — випадковий секрет щонайменше 32 байти;
- поточні Google credentials, які вже використовують серверні API (`GOOGLE_SERVICE_ACCOUNT_EMAIL`/`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` або сумісні наявні назви).

Той самий `INTEGRATION_WORKER_SECRET` запишіть у Supabase Vault як `integration_worker_secret`. URL функції виду `https://<project-ref>.supabase.co/functions/v1/integration-worker` запишіть як `integration_worker_url`.

Приклад команд, у які значення передаються з локального захищеного середовища:

```sh
supabase secrets set INTEGRATION_WORKER_SECRET="..." GOOGLE_SERVICE_ACCOUNT_EMAIL="..." GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="..."
supabase functions deploy integration-worker --no-verify-jwt
```

SQL для Vault виконайте у SQL Editor, не додаючи секрет до git:

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/integration-worker', 'integration_worker_url');
select vault.create_secret('<same-random-secret>', 'integration_worker_secret');
```

## 3. Контрольований реліз

1. Зафіксуйте час останньої перевіреної незалежної копії.
2. Застосуйте міграції в порядку імен файлів:
   - `20260914140339_durable_recovery_sync.sql`;
   - `20260914140454_reliable_source_integrations.sql`.
3. Розгорніть `integration-worker` і зробіть тестовий POST із заголовком `Authorization: Bearer <INTEGRATION_WORKER_SECRET>`. Очікувана відповідь: HTTP 202.
4. Розгорніть frontend/API цього ж commit.
5. Відкрийте застосунок у двох вкладках, змініть різні поля одного дня і дочекайтеся стану «Збережено на сервері» в обох вкладках.
6. Вимкніть мережу, зробіть зміну, перезавантажте вкладку, увімкніть мережу. Черга має перейти зі стану «Очікує мережі» у «Збережено на сервері».
7. Відкрийте панель стану даних у налаштуваннях: прострочених source jobs немає, остання копія молодша за 26 годин, конфлікти та quarantined operations відображаються окремо. Для серверної діагностики ця панель викликає RPC `get_data_health`.

## 4. Перевірка Google та файлів

1. Запустіть одну синхронізацію Sheets і Drive вручну. Наступні запуски створює `pg_cron` кожні 5 хвилин.
2. Переконайтеся, що ручна примітка до угоди не змінилася після Google sync.
3. Завантажте великий скріншот, перервіть мережу і відновіть її. Передача повинна продовжитися з серверного offset.
4. Відкрийте старий і новий скріншот через авторизований signed URL. Публічний URL bucket більше не повинен працювати.
5. Видаліть скріншот і перевірте, що він потрапив у 30-денний кошик, а байти не були видалені.

## 5. Відкат релізу

Якщо проблема лише у frontend, поверніть попередній deployment, але залиште блокування старих прямих записів. Старий frontend призначений лише для читання після нової міграції.

Якщо пошкоджені дані користувача, створіть точку відновлення, виконайте `preview_restore`, а потім `restore_data`. Відновлення збільшить покоління даних; черги зі старого покоління залишаться доступними для експорту і не накладуться автоматично.

Якщо втрачено весь Supabase-проєкт, створіть чистий проєкт, відновіть останній restic snapshot, виконайте `pg_restore` і поверніть Storage-файли за маніфестом. Після звірки кількості записів та SHA-256 оновіть deployment secrets на новий project URL і ключі.
