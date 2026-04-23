# Partials Map

`index.html` is intentionally kept as a page shell. Feature markup lives here:

- `layout/` - persistent layout pieces: app header, sidebars, image preview.
- `views/` - top-level app tabs such as dashboard, calendar, stats, settings.
- `modals/` - overlays and modal UI.

Partials are loaded by `js/partials.js` before the main UI initialization runs.
