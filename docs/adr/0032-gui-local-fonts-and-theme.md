# GUI fonts are bundled, and the theme is a per-browser preference

The three typefaces (Bricolage Grotesque, IBM Plex Sans, JetBrains Mono) ship as local files with the GUI and are never loaded from a CDN, so Segno works offline. The theme choice (system, light or dark) is stored per browser, not in config. With no choice made, it follows `prefers-color-scheme`. All motion is disabled under `prefers-reduced-motion`.
