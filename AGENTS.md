# CLAUDE.md — Trading Journal Pro (Календар)

Vanilla JS trading journal / calendar PWA with Node tooling, Vercel serverless
API, and Supabase. No framework SPA bundler for the main UI — `index.html` +
`js/` + `partials/` + CSS cascade.

## Stack

- **UI:** `index.html`, `partials/`, `js/*.js`, `css/` (ordered cascade in head)
- **API:** `api/*.js` on Vercel (rewrites in `vercel.json`; crons for sheets sync)
- **Data:** Supabase (`supabase/`), local/dev helpers in `dev-server.mjs`
- **Tooling:** Node ESM (`"type": "module"`), scripts in `package.json`
- **Docs:** `docs/ARCHITECTURE.md` is the map — read it before large UI changes

## Commands

- `npm run dev` / `npm run start` — local app
- `npm run check` — syntax check across JS modules
- `npm test` — test suite
- `npm run validate` / `npm run audit` — project checks

## Layout

| Area | Role |
| --- | --- |
| `partials/views/` | Tab HTML (dash, calendar, trades, ai, …) |
| `js/` | Screen modules; `*_core.js` = DOM-free logic |
| `lib/` | Shared server/client helpers |
| `api/` | Vercel handlers (gemini, sheets, trade-polygons, …) |
| `supabase/` | Migrations / functions — do not commit `.secrets.env` |

## Conventions

- One screen → one JS module; keep `*_core.js` free of DOM
- Clicks via `[data-action]` (`js/app_enhancements.js`); do not grow `window.*` via `exposeAppApi`
- New CSS goes in the existing thematic cascade file — not `13_fixes.css`, no new numbered sheets
- Do not merge tabs without an explicit product decision
- Env files: `.env`, `.env.local`, `config.js` secrets stay gitignored

## Safe changes

- Partial/view copy and tab modules with matching `npm run check`
- API handlers under `api/` with schema/docs updates when contracts change
- Supabase migrations as new files — never rewrite applied history casually

## Avoid

- Committing `.env*`, Supabase secrets, or sync tokens
- Large drive-by refactors across all tabs
- Adding a second CSS numbering scheme or a parallel SPA framework without agreement
