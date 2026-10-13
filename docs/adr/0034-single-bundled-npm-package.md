---
status: superseded by ADR-0043
---

# Segno ships as one bundled `segno` package on npm

Segno is installed as a single public npm package, `segno` (`npm i -g segno`), whose `segno` bin is the CLI. The workspace packages are bundled into it and stay `private: true`. The only runtime dependency left unbundled is `better-sqlite3`, because it's a native addon. The package declares a Node 22 LTS floor in `engines`. The Plan file and config JSON Schemas ship inside the package and are also committed to the repo at a stable path, so writers can validate without installing or running Segno [ADR-0002] [ADR-0025]. One installable artifact matches the one-process product, and keeping the internals unpublished leaves them free to change. Nothing is published until v1 is complete. Until then, the package is installed from a local tarball.

## Considered Options

- **Publish every `@segno/*` package.** Third parties could import the validator, but that makes the internals a versioned public API and means several packages to release. The published JSON Schema already serves outside Plan writers.
- **No publishing in v1** (clone and `pnpm link --global`). This only postpones the decision, and the user journey assumes `segno` is already on PATH [brief §User journey].
- **GitHub Packages or release tarballs.** GitHub Packages makes users authenticate even to install a public package. Tarballs have no registry, version resolution or `npx`.
