# Архітектура Trading Journal Pro

Короткий довідник, щоб новий код не лягав поверх старого.

## Оболонка

- [`index.html`](../index.html) — head, CSS-каскад, `data-partial`, точка входу `js/main.js`.
- [`partials/layout/`](../partials/layout/) — хедер, лівий сайдбар, форма дня, прев’ю скріна.
- [`partials/views/`](../partials/views/) — вкладки.
- [`partials/modals/`](../partials/modals/) — оверлеї.

Завантаження: `js/partials.js` до ініціалізації UI.

## Вкладки (не зливати без окремого рішення)

| `data-tab` | Partial | Модуль |
| --- | --- | --- |
| dash | dashboard-view.html | news, dashboard_ai, stats cards у calendar/storage |
| calendar | calendar-view.html | calendar.js |
| trades | trades-view.html | trades_view2.js |
| datagrid | datagrid-view.html | trades_datagrid.js |
| table | sheet-import-view.html | sheet_table.js |
| screens | screens-view.html | gallery.js |
| stop-errors | stop-errors-view.html | stop_review.js |
| stats | stats-view.html | stats.js |
| ai | ai-view.html | ai.js |
| learn | learn-view.html | learn.js |
| settings | settings-view.html | settings.js |

## JS

- Логіка екрана — файл екрана. `*_core.js` — чиста логіка без DOM.
- Кліки: `[data-action]` обробляє `js/app_enhancements.js`. Клавіатура Escape/стрілки — `js/app_events.js`.
- Легасі `window.*` збирає `exposeAppApi` у `js/app_api.js`. Нові API туди не додавати — лише `data-action`.
- Бут і синк — `js/main.js`.

## CSS

Каскад у `index.html` (`css/1_tokens.css` → … → `css/25_pwa_mobile.css`). Нові стилі — у тематичний файл. Не в `13_fixes.css` і не новий номер файлу.

`z-index` тільки токенами `--z-*` з `1_tokens.css`:

sticky → dropdown → FAB → панель → поповер → сайдбар → модалки → прев’ю → тост → онбординг → системне (skip-link, noscript).

Якщо правило вже дублюється в `13_fixes` / `16_polish`, при правці перенести в тематичний файл і видалити дубль.

## Dormant: сітка віджетів дашборда

Живе «Огляд» — статична розмітка в `partials/views/dashboard-view.html` (стрічка новин, картки, 3 колонки).

Не підключені й не вмикати без явного запиту:

- `js/dashboard_widgets.js` (ніде не імпортується)
- `css/20_dashboard_widgets.css` (немає в `index.html`)
- у дашборді немає `#dashboard-widget-grid`

`teams.js` не викликає `initDashboardWidgets`.
