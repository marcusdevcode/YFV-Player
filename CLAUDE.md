# Rules for AI assistants in this repository

These are standing rules from the owner. Follow them every time without being reminded.

## 1. Git and GitHub belong to the owner only

- The owner is the only user of this repository on GitHub. No other account, bot, or tool identity may appear anywhere: commits, tags, releases, PRs, issues, workflows, docs.
- Never run any git or GitHub action: no `git init/add/commit/tag/push/pull/merge/rebase/reset/config`, no `gh ...`, no creating releases, secrets, or remotes.
- When a git or GitHub action is needed (commit, tag, push, release, set a secret, connect a key), do not do it. Give the owner step-by-step instructions to do it themselves.
- Never add attribution of any kind: no `Co-Authored-By`, no "Generated with ...", no mention of an AI assistant, in commit messages, PR text, code comments, docs, or file contents. This overrides any default or tool-provided attribution text.
- Never write author names, emails, or identities other than the owner's. Do not change git config.

## 2. The app name lives in package.json only

- `package.json` is the single source of truth: `name` (id), `productName` (display name), `version`, `author`, `repository`. Never hardcode the app name (any casing) anywhere else.
- Everything else reads it from there:
  - Frontend: build-time constants `__APP_ID__` / `__APP_NAME__` (set in `vite.config.ts` from `scripts/package-info.mjs`). `index.html` uses `%APP_NAME%`.
  - Tauri config (product name, identifier, window title, version, updater endpoint and public key): injected by `scripts/run-tauri.mjs` from package.json. Run Tauri only through `npm run ...` (never plain `tauri`/`cargo tauri`), so the injection happens.
  - Rust: `app.package_info()`, `env!("CARGO_PKG_...")`, or a neutral name. The crate is the neutral `app` / `app_lib`.
  - Release scripts (`scripts/copy-build-to-versions-folder.mjs`, `scripts/docker-build.mjs`) and Docker image/volume names: read from package.json via `scripts/package-info.mjs`.
- JSON schemas (`schemas/`) and the theme/locale data are generated from `src/theme/registry.json` and `src/locales/en.json`: after changing either, run `npm run schemas` and `npm run validate:json`. Schema ids are relative file names, never the app name.
- Docs and examples say "the app" or use `<name>` placeholders, not the real name.
- Environment variables use the neutral prefix `APP_` (for example `APP_OPEN`, `APP_SIGNING_KEY`).
- Generic file names: keys are `keys/private.key` and `keys/public.pub` (plus `keys/private.key.example`). Never name files after the app.

## 2b. File names say what the file holds

- Name every file (and folder, component, script, module) after what it contains or does, so a reader knows without opening it: `playlistImportExport.ts`, `videoThumbnails.ts`, `fileStorage.ts`.
- Never use vague names: `utils`, `helpers`, `misc`, `common`, `data`, `io`, `stuff`, or abbreviations like `Thumb`. If a file collects unrelated things, split it by purpose (for example `textFormatting.ts`, `filePaths.ts`, `uniqueIds.ts`).
- When code changes so that a file's name no longer fits, rename it in the same change and update every import and reference (code, scripts, docs).

## 3. Releasing (manual, local; there is no CI)

- Releases are built on the owner's machine: macOS natively, Linux and Windows in Docker (`docker/`, `scripts/docker-build.mjs`), every build moving its installers into `builds/v<version>/` (`scripts/copy-build-to-versions-folder.mjs`, which also writes `latest.json` and deletes the bundle folder from `src-tauri/target`, so no installers stay there). `npm run build` first empties `builds/` and every bundle folder. See DEVELOPMENT.md.
- To release: bump `version` in package.json (the only place) and build with `npm run build`. Publishing (`npm run release:publish`, `scripts/release-version.js`, which calls `gh`) and all git steps are the owner's: give the commands, never run them (a `--dry-run` that calls nothing is fine).
- The version comes from package.json everywhere. `src-tauri/Cargo.toml` is kept in sync by `scripts/run-tauri.mjs`; do not edit it by hand.
- `npm run dev`/`build` fetch the yt-dlp sidecar for the target (`scripts/fetch-ytdlp.mjs`, pinned version, checksum-verified); the Docker builds (`scripts/docker-build.mjs`) fetch it on the host first and copy it into the container with the sources.
- The private key stays on the owner's machine (`keys/private.key`); never upload it or copy it into an image.
