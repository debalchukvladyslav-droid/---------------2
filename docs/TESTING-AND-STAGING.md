# Testing and staging setup

## Safety rule

Never point the test seed at the production project. Create a separate Supabase project named `Trader Journal Pro Staging` and use only its URL and service-role key.

## One-time setup

1. Create the staging Supabase project.
2. Link a separate working copy to staging and apply the SQL files from `database/` and `supabase/migrations/`.
3. Copy `.env.test.example` to `.env.test.local`.
4. Fill in the staging URL, service-role key, and unique test passwords.
5. Run `npm run test:seed`.

Generated accounts:

- `test.trader@example.com` — populated trader journal;
- `test.mentor@example.com` — mentor role in the same demo team;
- `test.admin@example.com` — admin-role UI checks.

Passwords are read only from `.env.test.local` and must never be committed or pasted into chat.

## Critical product flows

1. Sign in as trader and open dashboard, calendar and daily form.
2. Enter PnL and КФ, save the day, reload, and verify values persist.
3. Connect a test Drive folder, sync screenshots, disconnect Google, and verify images still load from Supabase Storage.
4. Close the trading session, classify every screenshot, and verify the review timestamp.
5. Switch to mentor, open the trader profile and review queue, and verify private edits remain blocked.
6. Switch to admin and verify administration screens without changing production data.
7. Repeat dashboard, calendar, screenshots, session review and settings at 390 px and 1440 px widths.

## Product priorities

1. No loss or cross-account mixing of journal data.
2. Screenshot persistence independent of Google access.
3. Correct PnL and КФ calculations and saves.
4. Clear trader/mentor/admin permissions.
5. Consistent desktop and mobile interface.
6. Animations and decorative polish only after the flows above pass.

## Visual direction

- compact professional trading interface;
- one control system for buttons, date inputs, selects and fields;
- restrained motion and strong numerical readability;
- dark themes as the default, with accessible light alternatives;
- screenshots and trading results take priority over decoration.

Place approved reference screenshots in `docs/design-references/`. Do not include screenshots containing private account or trading information.
