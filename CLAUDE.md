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
  - Frontend: build-time constants `__APP_ID__` / `__APP_NAME__` (set in `vite.config.ts` from `scripts/app-info.mjs`). `index.html` uses `%APP_NAME%`.
  - Tauri config (product name, identifier, window title, version, updater endpoint and public key): injected by `scripts/tauri.mjs` from package.json. Run Tauri only through `npm run ...` (never plain `tauri`/`cargo tauri`), so the injection happens.
  - Rust: `app.package_info()`, `env!("CARGO_PKG_...")`, or a neutral name. The crate is the neutral `app` / `app_lib`.
  - CI workflow: reads name and version from package.json in a step.
- Docs and examples say "the app" or use `<name>` placeholders, not the real name.
- Environment variables use the neutral prefix `APP_` (for example `APP_OPEN`, `APP_SIGNING_KEY`).
- Generic file names: keys are `keys/private.key` and `keys/public.pub` (plus `keys/private.key.example`). Never name files after the app.

## 3. Releasing

- To release: bump `version` in package.json (the only place), then give the owner the git steps to commit, tag `v<version>`, and push. Do not run them.
- `scripts/tauri.mjs` and the workflow take the version from package.json. Do not edit a version anywhere else except `src-tauri/Cargo.toml`, which the Tauri wrapper keeps in sync.
