> **⚠️ 已归档 · V1.0。** 这是 DSH 浏览器方案的第一代：只保证「所有跳转都走 Google Chrome」，不区分网址，也不管走不走代理。
> 它之后演进出 [V2.0 chrome-clash-link](https://github.com/SeekAfterSeek/chrome-clash-link)（Chrome 打开时自动拉起 Clash），再到 [V3.0 dsh-url-router](https://github.com/SeekAfterSeek/dsh-url-router)（国内 → Edge 直连，境外 → Chrome + Clash 美国节点）。
>
> **新项目请直接用 V3.0 —— 本仓库不再维护，代码仅作历史保留。**

# Chrome Only Browser for DeepSeek Harness

**强制 DSH 里所有浏览器跳转只走 Google Chrome。** 无论系统默认浏览器是什么，DSH 自己去开网页时只能是 Chrome；没人提浏览器就默认 Chrome，只有用户明确点名才允许例外。

[English](README.en.md) | 中文

![platform](https://img.shields.io/badge/platform-Windows-0078D6)
![dsh](https://img.shields.io/badge/DeepSeek%20Harness-profile%20bundle-4B32C3)
![license](https://img.shields.io/badge/license-MIT-green)

## 它解决什么

模型在任务里“顺手打开一个网页”时，默认会落到 `Start-Process <url>`、`open`、`xdg-open`，也就是**操作系统的默认浏览器**；`dsh web` 启动时也会把 GUI 地址交给默认浏览器。默认浏览器是 Edge / Firefox / 360 时，DSH 的每一次跳转都跑到了别的浏览器里。

这个 bundle 把这件事钉死：五层机制，从提示词到配置覆盖。

| 层 | 机制 | 效果 |
| --- | --- | --- |
| 提示层 | `ctx.systemPrompt.section()` | 每轮请求注入硬规则 + Chrome 缺失时的授权流程 + 唯一例外条款 |
| 工具层 | `chrome_open` | 直接启动 `chrome.exe --new-window <url>`，**永不**回退系统默认浏览器 |
| 工具层 | `chrome_status` | Chrome 是否安装、实际用哪个可执行文件、宿主补丁真实状态 |
| 工具层 | `chrome_install` | 必须先拿到用户授权（`authorized: true`）才下载安装 Chrome |
| 拦截层 | `ctx.tools.guard()` | 拒绝 `Start-Process <url>`、`start <url>`、`Invoke-Item`、`explorer <url>`、`rundll32 url.dll`、`xdg-open`、`open`，以及 msedge / firefox / brave / vivaldi / chromium / 360 / QQ / Sogou / maxthon 等非 Chrome 启动 |
| 启动层 | `web-runtime` 配置覆盖 + Chrome 交接 | **`dsh web` 不再调用系统默认浏览器**：`openBrowser` 固定为 `false`，改由插件在服务器就绪后用 Chrome 打开同一个带 token 的地址；`--no-open` 仍然有效 |
| 宿主层 | Electron `shell.openExternal` 重定向 | Electron 主进程里可用时把外链交给 Chrome；桌面应用的 Host 是 Electron Node 子进程，那里 `require('electron')` 不可用，此层自动降级并如实上报 |

## 安装

仓库根目录就是 bundle 包（`package.json` 里声明了 `dsh.bundle.patch`）。

```powershell
git clone https://github.com/SeekAfterSeek/dsh-chrome-only.git
```

**桌面 profile（desktop）**：用 Plugin Manager 安装本地 bundle，或调 `plugin_manager` 的 `install_bundle`，target 指向仓库绝对路径。

**web profile（`dsh web` 用的那个）**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-WebProfile.ps1
```

它做与 Plugin Manager 相同的三步：`dependencies` 加 `link:` → `dsh.profile.bundles` 追加 → 用 DSH 自带的 pnpm 安装。重复执行安全。写回 `package.json` 必须无 BOM，否则 DSH 启动时报 `Unexpected token '﻿'`。

> ⚠️ 两个 profile 里记的是 `link:<仓库路径>`。仓库被移动或删除后，启动时会解析不到 bundle——把仓库放在固定位置。

## 用法

模型侧：打开网页只用 `chrome_open`，查状态用 `chrome_status`，装 Chrome 前必须先 `ask_user_question` 拿到授权再 `chrome_install`。

脚本侧：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Open-DshChrome.ps1 -Url https://example.com -NewWindow
```

退出码：`0` 已在 Chrome 中打开；`2` 网址非法；`3` 本机没有 Chrome（此时必须先申请安装授权，禁止换浏览器）。

或者直接用 Chrome 本体：

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" "https://example.com"
```

## 配置

```yaml
- id: chrome-only
  name: '@local/dsh-chrome-only'
  config:
    chromePath: ''                 # 显式指定 chrome.exe；留空自动探测（注册表 + 常见安装路径）
    newWindow: true                # 每次打开新窗口
    guardShellTools: true          # 拦截 shell 工具里的非 Chrome 浏览器启动
    patchElectronShell: true       # Electron 主进程可用时重定向 shell.openExternal
    openWebUiInChrome: true        # dsh web 就绪后由本插件用 Chrome 打开 GUI
    extraForbiddenBrowsers: []
```

Chrome 探测顺序：`chromePath` → `CHROME_ONLY_CHROME_PATH` → `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%` → 注册表 `App Paths\chrome.exe`。

## Chrome 缺失时

1. `chrome_open` 返回 `code: "CHROME_MISSING"`；
2. 模型必须用 `ask_user_question` 问：「授权下载并安装（推荐）」/「先不安装」；
3. 只有用户明确授权后，才能 `chrome_install { authorized: true }`；
4. 安装依次尝试 `winget install --id Google.Chrome` → 官方企业版 MSI 静默安装 → 提权 MSI；全失败则提示手动安装。

未授权调用返回 `NOT_AUTHORIZED`，不下载不安装。

## 验证

```powershell
node test\matcher.test.mjs      # 17 条拦截 + 17 条放行 + URL 规范化
node test\handoff.test.mjs      # dsh web 交接：正常→打开 / --no-open→不打开 / 关配置→不接手
powershell -File .\scripts\Open-DshChrome.ps1 -Url about:blank
```

实测（Windows 11 + Chrome 155，DSH desktop/web 两个 profile）：

| 检查 | 结果 |
| --- | --- |
| `chrome_open about:blank` | `ok:true`，新窗口开在 Chrome |
| `chrome_open` 本地 HTML | `ok:true`，`file:///…/sample.html` 在 Chrome 中打开 |
| `pwsh: start https://example.com` | 被 guard 拒绝：「检测到「系统默认浏览器」启动」 |
| `pwsh: & "C:\nope\msedge.exe" https://example.com` | 被 guard 拒绝：「检测到「msedge」启动」 |
| `pwsh: Test-Path ...firefox.exe` + 显式 chrome.exe 启动 | 放行（探测类命令不误伤） |
| `chrome_install authorized:false` | 拒绝，`NOT_AUTHORIZED` |
| `dsh --profile web --port 50778` | 打印 URL 后由 Chrome 打开，无 `opening the default browser` |

## 覆盖边界

- 桌面应用是「Electron 主进程 + Electron Node 子进程（Cordis Host）」两段结构。点外链、下载地址、登录页这几处 `shell.openExternal` 在主进程里，插件在子进程，够不到；`chrome_status` 会显示 `electronShellPatch.patched: false` 及原因。把系统默认浏览器设为 Chrome 即可顺带覆盖这几处。
- `.html` 这类文件扩展名关联是独立于默认浏览器的设置，插件不碰；`chrome_open` 对本地文件始终用 Chrome。
- `web_fetch` / `web_search` 是服务端取文本，不启动浏览器，不受规则影响。
- guard 只审命令行文本，审不到脚本文件内部（`pwsh -File deploy.ps1` 里写 `Start-Process msedge`）。
- `dsh web --no-open` 是用户明确表态“不要打开”，不打开任何浏览器。

## 诊断工具

不解包整个 `app.asar` 就能按关键字定位、列目录、导出单个文件：

```powershell
node tools\asar-scan.mjs "...\resources\app.asar" openExternal
node tools\asar-list.mjs "...\resources\app.asar" "dsh/node_modules/@deepseek-ai/dsh-web-app/lib"
node tools\asar-extract.mjs "...\resources\app.asar" "path/inside/asar.js" .\out.js
```

（`read` 能读 asar 内部路径，`rg` 不能——所以这三个脚本绕过解包。）

## 卸载

- 临时关闭：Plugin Manager 里关闭 `chrome-only` 行。
- 彻底移除：移除 bundle，并从两个 profile 的 `package.json` 去掉依赖与 bundles 条目，再跑一次 pnpm install。

## License

[MIT](LICENSE)
