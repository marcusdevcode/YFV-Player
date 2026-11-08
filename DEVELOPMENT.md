# Development guide

For people who want to run, change, build or fork the app. For what the app does and what is built so far, see [README.md](README.md).

## What you need

- **Node.js** 22 or newer (CI uses 22) and npm.
- **Rust** (stable) from https://rustup.rs.
- Platform tools for Tauri v2:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Windows:** Microsoft C++ Build Tools and the WebView2 runtime.
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`, plus the GStreamer plugins (`gstreamer1.0-libav`, `gstreamer1.0-plugins-good`, `gstreamer1.0-plugins-bad`) so videos play.

## Run and check

```sh
npm ci               # install dependencies
npm start            # run the desktop app in development (same as `npm run dev:app`)
npm run typecheck    # TypeScript check
cd src-tauri && cargo test    # Rust tests
```

`npm run dev` starts only the web page in a browser, without the desktop features (file dialogs, the media server, updates).

Rule for the UI code: **no timers** (`setInterval`, `setTimeout`, `requestAnimationFrame`). Drive things from media events such as `timeupdate` and from input events instead.

Handy for testing: a file path given on launch plays right away, and a second path is used as the separate audio track, e.g. `APP_OPEN=/path/video.mp4 APP_OPEN_AUDIO=/path/audio.m4a npm start`.

## Building

```sh
npm run build:app          # for this computer
npm run build:mac-arm64    # Apple Silicon        (needs a Mac)
npm run build:mac-x64      # Intel Mac            (needs a Mac, `rustup target add x86_64-apple-darwin`)
npm run build:win-x64      # Windows x64          (needs Windows)
npm run build:win-arm64    # Windows ARM64        (needs Windows)
npm run build:linux-x64    # Linux x64            (needs Linux)
npm run build:linux-arm64  # Linux ARM64          (needs Linux)
```

`build:mac`, `build:win`, `build:linux` and `build:all` run the groups. A build only works on its own operating system; the GitHub workflow (`.github/workflows/release.yml`) builds all six targets when you push a tag such as `v0.1.0`.

Extra arguments go to `tauri build`: `npm run build:app -- --bundles app` builds just the app without an installer (useful on macOS, where the `.dmg` step sometimes fails with "resource busy").

All `build:*` scripts, `npm start` and `npm run tauri` go through `scripts/tauri.mjs`. It takes the product name, bundle identifier, version, window title and updater endpoint from `package.json` (the only place they are defined) and finds the signing key for you (next section). Do not run `tauri` or `cargo tauri` directly, or that information is missing.

## Releasing

`package.json` is the central place. To release: change `version` there (nothing else; `scripts/tauri.mjs` syncs `src-tauri/Cargo.toml`), then do the git steps yourself: commit, tag `v<version>` and push the tag (the workflow refuses a tag that differs from the version in `package.json`).

## Update-signing keys (read this if you copy the repo)

The app updates itself from GitHub Releases. To be sure an update really comes from you, every release is **signed with a private key**, and the app contains the matching **public key** and refuses updates that don't match.

| File | What it is | In git? |
|---|---|---|
| `keys/private.key` | Your **private** key. Secret. | **No**, ignored by `*.key` in `.gitignore` |
| `keys/private.key.example` | A placeholder that shows where the key goes. | Yes |
| `keys/public.pub` | The **public** key (safe to share). Read automatically by `scripts/tauri.mjs`. | **Yes**, commit it |

**The repository does not contain a working private key.** If you copy or fork this project you must make your own, otherwise your builds can't be signed the way the app expects:

1. **Generate a key pair** (add `--ci` to skip the password prompt, or enter a password and see below):
   ```sh
   npm run tauri -- signer generate -w keys/private.key
   ```
   The tool writes `keys/private.key` (private) and `keys/private.key.pub`. Rename the second file to `keys/public.pub`.
2. **The public key needs no pasting.** `keys/public.pub` is picked up automatically for every run and build.
3. **Point updates at your repository.** Set `repository.url` (and `author.name`, which forms the bundle identifier) in `package.json`. The update address is derived from it.
4. **Give GitHub the private key** so the workflow can sign releases. In your repository open *Settings → Secrets and variables → Actions → New repository secret* (a repository secret, not an environment) and create `TAURI_SIGNING_PRIVATE_KEY` with the **contents** of `keys/private.key`. With the GitHub CLI: `gh secret set TAURI_SIGNING_PRIVATE_KEY < keys/private.key`. If you protected the key with a password, also create `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
5. **Release:** push a tag matching `version` in `package.json` (for example `git tag v0.1.0 && git push origin v0.1.0`). The repository must be public for the free GitHub Actions minutes and for the updater to read the release.

**Local builds** pick the key up automatically from `keys/private.key` (another location: `APP_SIGNING_KEY=/path/to/key`; a key with a password: set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`). If there is **no key at all**, the build still works but produces no update files, and prints a message saying so. That is fine for trying things out.

**Keep the private key safe.**
- Never commit it, paste it into chats or issues, or put it in a screenshot. If it leaks, replace it (steps 1-4) **before** you publish your first release; after that, replacing it would stop already installed apps from updating.
- Back it up somewhere safe. If you lose it, installed apps can never be updated again.
- `.gitignore` blocks `*.key`, `*.pem`, `*.p12` and `.env*` files, and allows only `*.example` templates. Check `git status` before committing.

## Not covered by these keys

macOS and Windows code signing (so the OS doesn't warn on first launch) needs separate certificates from Apple and Microsoft. Without them, builds are unsigned and the OS shows a security warning. The keys above only protect updates.

## Troubleshooting

- **`.dmg` fails with "resource busy" on macOS:** run the build again, or build only the app: `npm run build:app -- --bundles app`.
- **"Open with" doesn't show the app:** it only works in an installed build, not in `npm start`.
- **A video won't play (error 4):** the file's codec isn't supported by the system's web view (typically VP9/AV1 or MKV/AVI). H.264/AAC MP4 works everywhere.
- **Don't commit large media files.** Keep test videos outside the repository.
