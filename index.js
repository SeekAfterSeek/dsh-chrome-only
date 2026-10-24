/**
 * @local/dsh-chrome-only
 *
 * DSH 强制规则：在本机打开任何网页（任务访问、OAuth/账号授权、看文档、预览报告、
 * 点击链接……）只允许使用 Google Chrome。其他浏览器一律禁止，与用户的默认浏览器无关。
 *
 * 三层实现：
 *   1) 工具层 —— `chrome_open` / `chrome_status` / `chrome_install`：
 *      直接用 chrome.exe 打开网址，永不回退到系统默认浏览器；
 *      Chrome 不存在时返回 CHROME_MISSING，要求模型先用 ask_user_question 征得授权，
 *      授权后才允许 `chrome_install` 下载安装。
 *   2) 拦截层 —— `ctx.tools.guard()`：任何 shell 工具里用 Start-Process / start /
 *      Invoke-Item / explorer / rundll32 url.dll / xdg-open / open 打开网址，
 *      或启动 msedge / firefox / brave / 360 / QQ 等非 Chrome 浏览器，一律拒绝执行。
 *   3) 宿主层 —— 尽力把 Electron 的 `shell.openExternal` 重定向到 Chrome，
 *      覆盖 GUI 里点击外链这类不经过模型的跳转。
 *
 * 另有一个独立的 PowerShell 脚本 scripts/Open-DshChrome.ps1，
 * 供脚本/终端上下文在没有工具可用时使用（同样只走 Chrome）。
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

export const name = 'chrome-only'
export const inject = ['tools']

const __dirname = dirname(fileURLToPath(import.meta.url))
const HELPER_SCRIPT = join(__dirname, 'scripts', 'Open-DshChrome.ps1')

const DEFAULT_CONFIG = {
  /** 显式指定 chrome.exe 路径；留空则自动探测。 */
  chromePath: '',
  /** 每次打开都新开一个窗口。 */
  newWindow: true,
  /** 拦截 shell 工具里的非 Chrome 浏览器启动。 */
  guardShellTools: true,
  /** 尽力把 Electron shell.openExternal 重定向到 Chrome。 */
  patchElectronShell: true,
  /** `dsh web` 启动时由本插件把 GUI 地址交给 Chrome（取代系统默认浏览器）。 */
  openWebUiInChrome: true,
  /** 额外的非 Chrome 浏览器可执行文件名（小写，不含 .exe 也可）。 */
  extraForbiddenBrowsers: [],
}

/** 运行期状态，供 chrome_status 报告。 */
let electronPatchStatus = { patched: false, reason: 'not attempted' }
let webHandoffStatus = { attempted: false }

/* ------------------------------------------------------------------------------------------------
 * 规则文本（本插件的核心：即使模型某次忘了用工具，也会读到这段硬规则）
 * ---------------------------------------------------------------------------------------------- */

function ruleText(config) {
  return `## Browser rule (MANDATORY — Google Chrome only)

DSH 规定：在本机打开任何网页，只允许使用 Google Chrome。无论用户把哪个浏览器设为默认，都一样。

适用范围（任何原因、任何任务）：
- 任务过程需要看网页、打开文档/报告/本地 HTML、预览站点、抓取后要人工核对；
- OAuth / 账号登录 / MCP 服务器授权 / 第三方服务回调；
- 用户说“打开这个链接”“帮我去看看”；
- 任何脚本、后台任务、子代理（subagent）产生的浏览器跳转。

执行方式：
- 打开网页 → 调用 \`chrome_open\`（参数 url）。它只启动 chrome.exe，绝不回退到系统默认浏览器。
- 想知道 Chrome 在不在 → \`chrome_status\`。
- Chrome 不存在时 \`chrome_open\` 返回 \`code: CHROME_MISSING\`。此时**必须**先用 \`ask_user_question\` 询问用户是否授权下载安装 Google Chrome：
  header「授权安装 Chrome」，选项「授权下载并安装（推荐）」/「先不安装」。
  只有用户明确选了授权，才可以调用 \`chrome_install\`（\`authorized: true\`）。未获授权不得下载、不得安装。
- 禁止：Edge/msedge、Firefox、Brave、Opera、Vivaldi、Chromium、360、QQ、Sogou、Maxthon 等任何其他浏览器；
  禁止用 \`Start-Process <url>\`、\`start <url>\`、\`Invoke-Item <url>\`、\`explorer <url>\`、
  \`rundll32 url.dll\`、\`xdg-open\`、\`open\` 让系统默认浏览器接管。这些调用会被 guard 直接拒绝。
- 若必须用 shell（例如某段脚本要开网页），用 Chrome 可执行文件本身：
  \`& "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe" "<url>"\`，
  或调用 ${HELPER_SCRIPT} 。
- \`web_fetch\` / \`web_search\` 只用于读取文本内容，不算“打开浏览器”；需要把页面给人看时用 \`chrome_open\`。

启动期（不需要任何人下指令的“自行打开”）：
- \`dsh web\` 的默认浏览器交接已被关闭：本插件在服务器就绪后，用 Chrome 打开同一个带 token 的地址；
  原版那句“opening the default browser”不会再出现。\`--no-open\` 仍然有效（用户明确表示不要打开）。
- 桌面应用的 GUI 本来就跑在 Electron 窗口里，不会去启动默认浏览器。

唯一的例外：
- 只有当用户在本次对话中**明确**说“用系统默认浏览器打开”或点名某个浏览器时，才允许例外：
  此时用 \`chrome_open\` 并传 \`browser: "default"\`（或让用户自己启动那个浏览器）。
  没有人提到浏览器时，一律 Chrome，没有“顺手用一下默认浏览器”的空间。

这条规则优先级高于默认设置、脚本习惯和用户偏好；任何“顺便用一下别的浏览器”的捷径都算违规。`
}

/* ------------------------------------------------------------------------------------------------
 * Chrome 定位
 * ---------------------------------------------------------------------------------------------- */

let registryCache

function windowsCandidates(env) {
  const list = []
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA
  list.push(join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  list.push(join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  if (localAppData) list.push(join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  return list
}

function candidateList(config, env = process.env) {
  const out = []
  if (config.chromePath) out.push(config.chromePath)
  if (env.CHROME_ONLY_CHROME_PATH) out.push(env.CHROME_ONLY_CHROME_PATH)
  if (process.platform === 'win32') out.push(...windowsCandidates(env))
  else if (process.platform === 'darwin') out.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  else out.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome')
  if (registryCache) out.push(registryCache)
  return out.filter(Boolean)
}

/** 同步探测（guard 与 Electron 补丁用）。 */
export function locateChromeSync(config = DEFAULT_CONFIG, env = process.env) {
  for (const candidate of candidateList(config, env)) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 忽略不可读路径 */
    }
  }
  return undefined
}

function runFile(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: options.timeoutMs ?? 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error?.code ?? 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error,
        })
      },
    )
  })
}

async function readRegistryChrome() {
  if (process.platform !== 'win32') return undefined
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe',
  ]
  for (const key of keys) {
    const result = await runFile('reg.exe', ['query', key, '/ve'], { timeoutMs: 15000 })
    if (!result.ok) continue
    const match = result.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)
    if (!match) continue
    const raw = match[1].replace(/^"|"$/g, '').trim()
    if (raw && existsSync(raw)) return raw
  }
  return undefined
}

/** 异步探测（工具调用用，额外查注册表）。 */
export async function locateChrome(config = DEFAULT_CONFIG) {
  const direct = locateChromeSync(config)
  if (direct) return direct
  const fromRegistry = await readRegistryChrome()
  if (fromRegistry) {
    registryCache = fromRegistry
    return fromRegistry
  }
  return undefined
}

async function waitForChrome(config, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await locateChrome(config)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
  return undefined
}

/* ------------------------------------------------------------------------------------------------
 * URL 规范化与启动
 * ---------------------------------------------------------------------------------------------- */

const ALLOWED_SCHEMES = new Set(['http', 'https', 'file', 'about', 'chrome', 'view-source', 'chrome-extension'])

export function normalizeUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('url 不能为空')
  if (raw.length > 8192) throw new Error('url 过长')
  if (/^[A-Za-z]:\\/.test(raw) || raw.startsWith('\\\\')) {
    return 'file:///' + raw.replace(/\\/g, '/').replace(/ /g, '%20')
  }
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/)
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase()
    if (!ALLOWED_SCHEMES.has(scheme)) throw new Error(`不支持的协议：${scheme}`)
    return raw
  }
  return 'https://' + raw
}

function launchChrome(executable, url, newWindow) {
  const args = []
  if (newWindow) args.push('--new-window')
  args.push(url)
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

/* ------------------------------------------------------------------------------------------------
 * 拦截规则：shell 工具里的浏览器启动
 * ---------------------------------------------------------------------------------------------- */

const CHROME_REFERENCE = /\bchrome(?:\.exe)?\b|\bgoogle[\\/]chrome\b/i

const GENERIC_OPEN_PATTERNS = [
  /\bstart-process\b[^;\r\n]{0,200}?(?:https?:\/\/|file:\/\/|www\.)/i,
  /(?:^|[;&|]\s*)start(?:\s+|$)[^;\r\n]{0,200}?(?:https?:\/\/|file:\/\/|www\.)/i,
  /\binvoke-item\b[^;\r\n]{0,200}?(?:https?:\/\/|file:\/\/|www\.)/i,
  /\brundll32(?:\.exe)?\s+url\.dll/i,
  /\bxdg-open\b[^;\r\n]{0,200}?(?:https?:\/\/|file:\/\/|www\.)/i,
  /\bexplorer(?:\.exe)?\b[^;\r\n]{0,200}?(?:https?:\/\/|file:\/\/|www\.)/i,
  /\bcmd(?:\.exe)?\s*\/c\s+start\b/i,
  /(?:^|[;&|]\s*)open\s+["']?(?:https?:\/\/|www\.|file:\/\/)/i,
]

const NON_CHROME_NAME =
  /\b(msedge|microsoft-edge|edge\.exe|firefox(?:\.exe)?|iexplore|internet explorer|opera(?:\.exe)?|brave(?:\.exe)?|bravebrowser\.exe|vivaldi(?:\.exe)?|chromium(?:\.exe)?|360se|360chrome|qqbrowser|sogouexplorer|maxthon|librewolf(?:\.exe)?|waterfox(?:\.exe)?|palemoon(?:\.exe)?|safari)\b/i

const LAUNCH_VERB =
  /^(?:start-process|saps|start|invoke-item|explorer(?:\.exe)?|rundll32(?:\.exe)?|xdg-open|open|exec|spawn|launch|call|cmd(?:\.exe)?\s*\/c)\b/i

/** 允许“裸名字就是命令”的形式，例如 `firefox https://x`。 */
const BARE_BROWSER_NAMES =
  '(?:msedge|firefox|firefox\\.exe|iexplore|opera|brave|vivaldi|chromium|360se|360chrome|qqbrowser|sogouexplorer|maxthon|librewolf|waterfox|palemoon)'

/**
 * 取一条语句里“被启动的那个可执行/目标”的 token。
 * 只关心启动位置，`Test-Path "...\firefox.exe"` 这类检查不会被误判。
 */
function launchTarget(statement) {
  let text = String(statement).trim().replace(/^&\s*/, '')
  text = text.replace(/^cmd(?:\.exe)?\s*\/c\s+start\s+/i, '')
  const verb = text.match(LAUNCH_VERB)
  if (verb) {
    text = text.slice(verb[0].length).trim()
    text = text.replace(/^(?:-\w+(?::\w+)?\s+)+/, '')
  }
  const quoted = text.match(/^"([^"]*)"|^'([^']*)'/)
  if (quoted) return quoted[1] ?? quoted[2] ?? ''
  const plain = text.match(/^(\S+)/)
  return plain ? plain[1] : ''
}

/**
 * 判断一段命令行文本是否会打开“非 Chrome 浏览器”。
 * 返回 { browser } 表示必须拒绝；返回 undefined 表示放行。
 */
export function findForbiddenBrowserOpen(text) {
  const source = String(text ?? '')
  if (!source.trim()) return undefined

  // 1) 启动位置出现非 Chrome 浏览器（含 microsoft-edge: 协议）。
  for (const statement of source.split(/\r?\n|;|\|/)) {
    const target = launchTarget(statement)
    if (!target) continue
    if (/^microsoft-edge:/i.test(target)) return { browser: 'microsoft-edge' }
    const named = target.match(NON_CHROME_NAME)
    if (!named) continue
    const looksLikeExecutable = /[\\/]/.test(target) || /\.exe"?$/i.test(target)
    const isBareName = new RegExp(`^${BARE_BROWSER_NAMES}$`, 'i').test(target)
    const statementHasUrl = /(https?:\/\/|www\.|file:\/\/)/i.test(statement)
    if (looksLikeExecutable || isBareName || statementHasUrl) return { browser: named[1] }
  }

  // 2) 交给系统默认浏览器打开 URL（本次调用里没有出现 Chrome）。
  if (!CHROME_REFERENCE.test(source)) {
    for (const pattern of GENERIC_OPEN_PATTERNS) {
      if (pattern.test(source)) return { browser: '系统默认浏览器' }
    }
  }

  return undefined
}

function collectCommandText(args) {
  if (!args || typeof args !== 'object') return ''
  const parts = []
  for (const key of ['command', 'code', 'script', 'cmd', 'input']) {
    const value = args[key]
    if (typeof value === 'string') parts.push(value)
  }
  return parts.join('\n')
}

const SHELL_TOOL_NAMES = new Set([
  'pwsh',
  'bash',
  'terminal',
  'run_code',
  'pwsh_persistent',
  'bash_persistent',
  'shell',
  'exec',
])

function buildGuard(config) {
  return (execution) => {
    if (!config.guardShellTools) return undefined
    const toolName = String(execution?.name ?? '')
    const text = collectCommandText(execution?.arguments)
    if (!text) return undefined
    if (!SHELL_TOOL_NAMES.has(toolName) && !/command/i.test(Object.keys(execution?.arguments ?? {}).join(','))) {
      return undefined
    }
    const forbidden = findForbiddenBrowserOpen(text)
    if (!forbidden) return undefined
    return (
      `DSH 浏览器规则：所有浏览器跳转必须使用 Google Chrome，检测到「${forbidden.browser}」启动。` +
      '本次调用已被拒绝。请改用 chrome_open 工具；若本机没有 Chrome，先用 ask_user_question 询问用户是否授权下载安装，' +
      '再调用 chrome_install（authorized: true）。'
    )
  }
}

/* ------------------------------------------------------------------------------------------------
 * 安装（必须先拿到用户授权）
 * ---------------------------------------------------------------------------------------------- */

const MSI_URL = 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi'

function tail(text, limit = 600) {
  const value = String(text ?? '').trim()
  return value.length > limit ? '…' + value.slice(-limit) : value
}

async function installChrome(config, method) {
  const attempts = []
  const useWinget = method === 'auto' || method === 'winget'
  const useMsi = method === 'auto' || method === 'msi'

  if (useWinget) {
    const result = await runFile(
      'winget.exe',
      [
        'install',
        '--id',
        'Google.Chrome',
        '--exact',
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--source',
        'winget',
      ],
      { timeoutMs: 900000 },
    )
    attempts.push({ step: 'winget', ok: result.ok, code: result.code, output: tail(result.stdout + result.stderr) })
    const found = await locateChrome(config)
    if (found) return { ok: true, executable: found, attempts }
  }

  if (useMsi) {
    const msiPath = join(tmpdir(), 'chrome-standalone-enterprise64.msi')
    try {
      const response = await fetch(MSI_URL, { redirect: 'follow' })
      if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      await writeFile(msiPath, bytes)
      attempts.push({ step: 'download', ok: true, bytes: bytes.length, path: msiPath })

      const silent = await runFile('msiexec.exe', ['/i', msiPath, '/qn', '/norestart'], { timeoutMs: 900000 })
      attempts.push({ step: 'msiexec', ok: silent.ok, code: silent.code, output: tail(silent.stderr || silent.stdout) })
      const found = await locateChrome(config)
      if (found) return { ok: true, executable: found, attempts }

      const elevated = await runFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `Start-Process msiexec.exe -Verb RunAs -ArgumentList '/i','${msiPath}','/qn','/norestart' -Wait`,
        ],
        { timeoutMs: 900000 },
      )
      attempts.push({
        step: 'msiexec-elevated',
        ok: elevated.ok,
        code: elevated.code,
        output: tail(elevated.stderr || elevated.stdout),
      })
      const installed = await waitForChrome(config, 180000)
      if (installed) return { ok: true, executable: installed, attempts }
    } catch (error) {
      attempts.push({ step: 'msi', ok: false, error: String(error?.message ?? error) })
    }
  }

  return { ok: false, attempts }
}

/* ------------------------------------------------------------------------------------------------
 * 宿主层：把 Electron 的外链打开重定向到 Chrome（尽力而为，失败不影响插件）
 * ---------------------------------------------------------------------------------------------- */

function patchElectronShell(config) {
  if (!config.patchElectronShell) return { patched: false, reason: 'disabled by config' }
  try {
    const require = createRequire(import.meta.url)
    const electron = require('electron')
    const shell = electron?.shell
    if (!shell || typeof shell.openExternal !== 'function') {
      return { patched: false, reason: 'electron shell.openExternal 不可用（非 Electron 主进程）' }
    }
    if (shell.__chromeOnlyOriginal) return { patched: true, reason: 'already patched' }
    const original = shell.openExternal.bind(shell)
    shell.openExternal = (url, options) => {
      try {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
          const executable = locateChromeSync(config)
          if (executable) {
            launchChrome(executable, url, config.newWindow)
            return Promise.resolve()
          }
        }
      } catch {
        /* 落到原始实现 */
      }
      return original(url, options)
    }
    Object.defineProperty(shell, '__chromeOnlyOriginal', { value: original, configurable: true })
    Object.defineProperty(shell, '__chromeOnlyPatched', { value: true, configurable: true })
    return { patched: true }
  } catch (error) {
    return { patched: false, reason: String(error?.message ?? error) }
  }
}

/* ------------------------------------------------------------------------------------------------
 * `dsh web` 的浏览器交接：取代 web-app 的默认浏览器启动
 * ---------------------------------------------------------------------------------------------- */

/** 用户明确要求“用默认浏览器”时才会走这里。 */
function launchDefaultBrowser(url) {
  const quoted = String(url).replace(/'/g, "''")
  if (process.platform === 'win32') {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${quoted}'`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
    return child.pid
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [url], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
  return child.pid
}

/**
 * `dsh --profile web` 原本用系统默认浏览器打开 GUI。插件把 web-runtime 行的
 * `openBrowser` 关掉，然后在同一时机（Loader 树就绪、连接可用）用 Chrome 打开
 * 同一个已认证地址；`--no-open` 与 SSH 启动仍然照旧不打开。
 */
function installWebHandoff(ctx, config) {
  if (config.openWebUiInChrome === false) {
    webHandoffStatus = { attempted: false, reason: 'disabled by config' }
    return webHandoffStatus
  }
  const status = { attempted: true, opened: false, reason: '', url: '' }
  webHandoffStatus = status
  try {
    ctx.inject(['webStartup', 'webServer'], (scoped) => {
      const startup = scoped.get('webStartup')
      if (startup?.openBrowser !== true) {
        status.reason = 'openBrowser=false（--no-open 或桌面端启动），按规则不打开'
        return
      }
      if (process.env.SSH_CONNECTION || process.env.SSH_TTY) {
        status.reason = 'SSH 启动，不打开本机浏览器'
        return
      }
      const announce = () => {
        try {
          const base = scoped.get('webApp')?.getAdvertisedUrl?.() ?? scoped.webServer.getOrigin()
          const connection = scoped.get('connection')
          const url = typeof connection?.authenticatedUrl === 'function' ? connection.authenticatedUrl(base) : base
          const executable = locateChromeSync(config)
          if (!executable) {
            status.reason = 'CHROME_MISSING'
            return
          }
          launchChrome(executable, url, config.newWindow)
          status.opened = true
          status.url = url
          process.stderr.write('dsh web: 已用 Google Chrome 打开（DSH 规则：禁止默认浏览器）\n')
        } catch (error) {
          status.reason = String(error?.message ?? error)
        }
      }
      const settled = scoped.get('loader')?.await?.()
      if (settled && typeof settled.then === 'function') settled.then(announce, () => {})
      else announce()
    })
  } catch (error) {
    status.reason = String(error?.message ?? error)
  }
  return status
}

/* ------------------------------------------------------------------------------------------------
 * 工具定义
 * ---------------------------------------------------------------------------------------------- */

function textResult(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

function chromeOpenTool(config) {
  return {
    name: 'chrome_open',
    description:
      'Open a web page (or local HTML file) in Google Chrome. This is the only permitted way to open a browser in DSH. ' +
      'Never falls back to the system default browser. If Chrome is missing it returns code CHROME_MISSING: ask the user ' +
      'for download authorisation with ask_user_question, then call chrome_install.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL, local file path, or bare domain such as example.com.' },
        newWindow: { type: 'boolean', description: 'Open in a new Chrome window instead of reusing one.' },
        browser: {
          type: 'string',
          description:
            "Defaults to 'chrome'. Use 'default' only when the user explicitly asked for the system default browser " +
            'or named another browser; never choose it on your own initiative.',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          browser: { type: 'string' },
          executable: { type: 'string' },
          url: { type: 'string' },
          pid: { type: 'number' },
          newWindow: { type: 'boolean' },
          code: { type: 'string' },
          instructions: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => textResult(value),
    },
    async execute(args) {
      let url
      try {
        url = normalizeUrl(args?.url)
      } catch (error) {
        return { ok: false, code: 'INVALID_URL', instructions: String(error?.message ?? error) }
      }

      // 唯一例外：用户明确点名“用默认浏览器/别的浏览器”。
      if (args?.browser && String(args.browser).toLowerCase() !== 'chrome') {
        const choice = String(args.browser).toLowerCase()
        if (choice !== 'default') {
          return {
            ok: false,
            code: 'NAMED_BROWSER_UNSUPPORTED',
            url,
            instructions:
              `本插件只安装并管理 Google Chrome，无法直接启动「${args.browser}」。` +
              '若用户确实点名要用它，请让用户自行从桌面启动该浏览器，或先用 Start-Process 指定其完整可执行文件路径' +
              '（这条路径仍受 guard 约束时，请向用户说明冲突）。',
          }
        }
        const pid = launchDefaultBrowser(url)
        return { ok: true, browser: 'system default (user explicitly requested)', url, pid: pid ?? null }
      }

      const executable = await locateChrome(config)
      if (!executable) {
        return {
          ok: false,
          code: 'CHROME_MISSING',
          url,
          browser: 'Google Chrome (not installed)',
          instructions:
            '本机未找到 Google Chrome。按 DSH 规则，此时不得改用其他浏览器。' +
            '请先调用 ask_user_question 询问用户是否授权下载并安装 Google Chrome；' +
            '只有用户选择授权后，才调用 chrome_install（authorized: true）。',
        }
      }
      const newWindow = args?.newWindow ?? config.newWindow
      const pid = launchChrome(executable, url, Boolean(newWindow))
      return {
        ok: true,
        browser: 'Google Chrome',
        executable,
        url,
        pid: pid ?? null,
        newWindow: Boolean(newWindow),
      }
    },
  }
}

function chromeStatusTool(config) {
  return {
    name: 'chrome_status',
    description:
      'Report whether Google Chrome is installed and which executable DSH will use. Use before asking the user for install authorisation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          installed: { type: 'boolean' },
          executable: { type: 'string' },
          platform: { type: 'string' },
          helperScript: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => textResult(value),
    },
    async execute() {
      const executable = await locateChrome(config)
      return {
        installed: Boolean(executable),
        executable: executable ?? '',
        platform: process.platform,
        helperScript: HELPER_SCRIPT,
        electronShellPatch: electronPatchStatus,
        webUiHandoff: webHandoffStatus,
      }
    },
  }
}

function chromeInstallTool(config) {
  return {
    name: 'chrome_install',
    description:
      'Download and install Google Chrome. Requires explicit user authorisation first: ask the user with ask_user_question, ' +
      'then call this tool with authorized=true. Refuses to run without that flag.',
    parameters: {
      type: 'object',
      properties: {
        authorized: {
          type: 'boolean',
          description: 'True only after the user explicitly approved downloading and installing Google Chrome.',
        },
        method: {
          type: 'string',
          description: 'auto (default), winget, or msi.',
        },
      },
      required: ['authorized'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          executable: { type: 'string' },
          attempts: { type: 'array' },
          instructions: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => textResult(value),
    },
    async execute(args) {
      if (args?.authorized !== true) {
        return {
          ok: false,
          code: 'NOT_AUTHORIZED',
          instructions:
            '未获得用户授权，已拒绝下载安装。请先调用 ask_user_question 询问是否授权下载并安装 Google Chrome，' +
            '用户明确同意后再以 authorized: true 重试。',
        }
      }
      const existing = await locateChrome(config)
      if (existing) {
        return { ok: true, executable: existing, attempts: [{ step: 'already-installed', ok: true }] }
      }
      const method = ['auto', 'winget', 'msi'].includes(args?.method) ? args.method : 'auto'
      const result = await installChrome(config, method)
      if (result.ok) return result
      return {
        ...result,
        instructions:
          '自动安装未成功。请让用户从 https://www.google.com/chrome/ 手动安装 Google Chrome，' +
          '安装完成后再调用 chrome_status / chrome_open。',
      }
    },
  }
}

/* ------------------------------------------------------------------------------------------------
 * 插件入口
 * ---------------------------------------------------------------------------------------------- */

export function apply(ctx, config) {
  const resolved = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }

  ctx.effect(() => ctx.tools.register(chromeOpenTool(resolved)))
  ctx.effect(() => ctx.tools.register(chromeStatusTool(resolved)))
  ctx.effect(() => ctx.tools.register(chromeInstallTool(resolved)))

  if (resolved.guardShellTools) {
    ctx.effect(() => ctx.tools.guard(buildGuard(resolved)))
  }

  const sectionDefinition = {
    name: 'chrome-only:browser-rule',
    order: 1200,
    text: ruleText(resolved),
  }
  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(() => systemPrompt.section(sectionDefinition))
  } else if (typeof ctx.inject === 'function') {
    // 服务在激活时尚未就绪：等 systemPrompt 挂载后再注册规则段。
    ctx.inject(['systemPrompt'], (inner) => {
      inner.effect(() => inner.systemPrompt.section(sectionDefinition))
    })
  }

  const electronPatch = patchElectronShell(resolved)
  electronPatchStatus = electronPatch
  const handoff = installWebHandoff(ctx, resolved)

  // 预热注册表探测，避免第一次 chrome_open 才付出额外延迟。
  if (process.platform === 'win32') {
    readRegistryChrome().then(
      (found) => {
        if (found) registryCache = found
      },
      () => {},
    )
  }

  ctx.on?.('dispose', () => {
    /* 资源由 ctx.effect 自动回收；这里只记录宿主补丁状态，不做额外清理。 */
    void electronPatch
  })

  return { electronPatch }
}

export const internals = {
  findForbiddenBrowserOpen,
  normalizeUrl,
  locateChromeSync,
  installWebHandoff,
  CHROME_MISSING: 'CHROME_MISSING',
}
