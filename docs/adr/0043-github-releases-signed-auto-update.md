# Segno is distributed through signed, auto-updating GitHub Releases

Releases are built with electron-builder and published as GitHub Releases: AppImage and .deb for Linux, and a signed and notarized .dmg for macOS. The app updates itself from those releases with electron-updater. A release is published only on the developer's explicit go. This supersedes ADR-0034. For ADR-0035, "the first published release" means the first GitHub Release.

## Considered Options

- **Unsigned macOS builds without auto-update in v1.** No Apple Developer Program membership is needed, but users hit Gatekeeper warnings, and macOS auto-update requires signing anyway.
- **The npm package from ADR-0034.** npm installs a CLI well, but not a desktop app.
