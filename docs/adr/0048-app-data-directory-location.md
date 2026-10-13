# Segno resolves its app data directory itself, and keeps Chromium's state inside it

On Linux, Electron's own `appData` is `~/.config`, not the `${XDG_DATA_HOME:-~/.local/share}/Segno` that store.md specifies, and Chromium keeps its runtime state, including the single-instance lock, in a separate `userData` directory. Segno therefore resolves the app data directory itself: `SEGNO_APP_DATA` when set, otherwise `${XDG_DATA_HOME:-~/.local/share}/Segno` on Linux and Electron's `appData` plus `Segno` on macOS. Electron's `userData` is set to `<appData>/chromium/`. Everything Segno and Electron store then lives under one directory, and pointing `SEGNO_APP_DATA` at a temporary directory isolates a whole app instance, lock included, which is how the end-to-end tests run.

## Considered Options

- **Leave Chromium's state in Electron's default `userData`.** Segno's state would be split across two directories, and a test instance would share the developer's real single-instance lock.
