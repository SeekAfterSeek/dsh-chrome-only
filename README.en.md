# Chrome Only Browser for DeepSeek Harness

**Every browser navigation inside DSH goes to Google Chrome.** It does not matter which browser is set as the OS default: when DSH opens a web page by itself, it is Chrome. Only an explicit user request may pick something else.

中文 | [English](README.en.md)

![platform](https://img.shields.io/badge/platform-Windows-0078D6)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-profile%20bundle-4B32C3)
![license](https://img.shields.io/badge/license-MIT-green)

## The problem

When a model "just opens a page" during a task, it usually ends in `Start-Process <url>`, `open`, or `xdg-open` — the **OS default browser**. `dsh web` also hands its GUI URL to the default browser at startup. With Edge, Firefox, or 360 as the default, every DSH jump lands in the wrong browser.

This bundle pins it down with five layers, from prompt text to a config override.

| Layer | Mechanism | Effect |
| --- | --- | --- |
| Prompt | `ctx.systemPrompt.section()` | Injects the hard rule, the Chrome-missing authorisation flow, and the single exception into every request |
| Tool | `chrome_open` | Launches `chrome.exe --new-window <url>`; **never** falls back to the system default |
| Tool | `chrome_status` | Reports whether Chrome exists, which executable is used, and the real state of the host patches |
| Tool | `chrome_install` | Requires explicit user authorisation (`authorized: true`) before downloading/installing Chrome |
| Guard | `ctx.tools.guard()` | Denies `Start-Process <url>`, `start <url>`, `Invoke-Item`, `explorer <url>`, `rundll32 url.dll`, `xdg-open`, `open`, and any launch of msedge / firefox / brave / vivaldi / chromium / 360 / QQ / Sogou / maxthon |
| Startup | `web-runtime` config override + Chrome handoff | **`dsh web` no longer opens the system default browser**: `openBrowser` is pinned to `false`, and the plugin opens the same tokenised URL with Chrome once the server is ready. `--no-open` still wins |
| Host | Electron `shell.openExternal` redirect | Redirects external links to Chrome where the Electron main process is reachable; the desktop Host runs as an Electron Node child, so that layer degrades and reports itself honestly |

## Install

The repository root is the bundle (`dsh.bundle.patch` is declared in `package.json`).

```powershell
git clone https://github.com/SeekAfterSeek/dsh-chrome-only.git
```

**desktop profile** — install the local bundle through Plugin Manager, or call `plugin_manager` `install_bundle` with the repository's absolute path.

**web profile** (the one `dsh web` uses):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-WebProfile.ps1
```

It performs the same three steps as Plugin Manager: a `link:` dependency, a `dsh.profile.bundles` entry, and an install with DSH's bundled pnpm. It is idempotent. The write-back must be BOM-free, otherwise DSH fails at startup with `Unexpected token '﻿'`.

> ⚠️ Both profiles store `link:<repo path>`. Moving or deleting the repository breaks bundle resolution at boot — keep it somewhere stable.

## Usage

Model side: open pages with `chrome_open`, inspect with `chrome_status`, and ask the user through `ask_user_question` before `chrome_install`.

Script side:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Open-DshChrome.ps1 -Url https://example.com -NewWindow
```

Exit codes: `0` opened in Chrome; `2` invalid URL; `3` Chrome is missing (ask for install authorisation — never switch browsers).

Or invoke Chrome directly:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" "https://example.com"
```

## Configuration

```yaml
- id: chrome-only
  name: '@local/dsh-chrome-only'
  config:
    chromePath: ''                 # explicit chrome.exe; empty = auto-detect (registry + well-known paths)
    newWindow: true
    guardShellTools: true
    patchElectronShell: true
    openWebUiInChrome: true
    extraForbiddenBrowsers: []
```

Detection order: `chromePath` → `CHROME_ONLY_CHROME_PATH` → `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%` → registry `App Paths\chrome.exe`.

## When Chrome is missing

1. `chrome_open` returns `code: "CHROME_MISSING"`;
2. the model must ask via `ask_user_question` — "authorise download and install" / "not now";
3. only after explicit approval may it call `chrome_install { authorized: true }`;
4. installation tries `winget install --id Google.Chrome`, then the official enterprise MSI silently, then an elevated MSI; on total failure it asks the user to install manually.

An unauthorised call returns `NOT_AUTHORIZED` and downloads nothing.

## Verification

```powershell
node test\matcher.test.mjs      # 17 deny cases + 17 allow cases + URL normalisation
node test\handoff.test.mjs      # dsh web handoff: normal → open / --no-open → skip / disabled → skip
powershell -File .\scripts\Open-DshChrome.ps1 -Url about:blank
```

Measured on Windows 11 + Chrome 155, both desktop and web profiles:

| Check | Result |
| --- | --- |
| `chrome_open about:blank` | `ok:true`, new Chrome window |
| `chrome_open` with a local HTML file | `ok:true`, `file:///…/sample.html` opened in Chrome |
| `pwsh: start https://example.com` | denied — "system default browser detected" |
| `pwsh: & "C:\nope\msedge.exe" https://example.com` | denied — "msedge detected" |
| `pwsh: Test-Path ...firefox.exe` + explicit chrome.exe launch | allowed (probe commands are not false-positived) |
| `chrome_install authorized:false` | denied, `NOT_AUTHORIZED` |
| `dsh --profile web --port 50778` | URL printed, opened by Chrome, no `opening the default browser` |

## Boundaries

- The desktop app is two processes: the Electron main process and the Electron Node child hosting Cordis. `shell.openExternal` (external-link clicks, download addresses, the login page) lives in the main process; the plugin runs in the child and cannot reach it. `chrome_status` reports `electronShellPatch.patched: false` with the reason. Setting the OS default browser to Chrome covers those sites as well.
- File-extension associations such as `.html` are independent of the default browser and are left untouched; `chrome_open` always uses Chrome for local files.
- `web_fetch` / `web_search` fetch text server-side and start no browser.
- The guard inspects command text only; it cannot see a launch written inside a script file (`pwsh -File deploy.ps1`).
- `dsh web --no-open` is an explicit instruction not to open anything, so nothing opens.

## Diagnostic tools

Inspect a 180 MB `app.asar` by keyword, list directories, or extract one file without unpacking it:

```powershell
node tools\asar-scan.mjs "...\resources\app.asar" openExternal
node tools\asar-list.mjs "...\resources\app.asar" "dsh/node_modules/@deepseek-ai/dsh-web-app/lib"
node tools\asar-extract.mjs "...\resources\app.asar" "path/inside/asar.js" .\out.js
```

## Uninstall

- Disable the `chrome-only` row in Plugin Manager, or
- remove the bundle, drop the dependency and bundle entry from both profiles, and run pnpm install again.

## License

[MIT](LICENSE)
