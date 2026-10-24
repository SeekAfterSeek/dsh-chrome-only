<#
.SYNOPSIS
    在 DeepSeek Harness (DSH) 中打开网页的唯一合法入口：只使用 Google Chrome。

.DESCRIPTION
    DSH 规则：任何浏览器跳转（任务访问、OAuth 授权、看文档、预览报告、点击链接……）
    都必须使用 Google Chrome，与系统默认浏览器无关。

    本脚本只在 Chrome 存在时启动它；不存在时输出 CHROME_MISSING 并以退出码 3 结束，
    调用方（模型/脚本）必须先向用户申请下载安装授权，禁止改用其他浏览器。

.PARAMETER Url
    要打开的网址、本地文件路径或裸域名（例如 example.com）。

.PARAMETER NewWindow
    新开一个 Chrome 窗口。

.PARAMETER ChromePath
    显式指定 chrome.exe；不传则依次查参数环境变量、注册表、常见安装路径。

.EXAMPLE
    .\Open-DshChrome.ps1 https://example.com
    powershell -NoProfile -ExecutionPolicy Bypass -File .\Open-DshChrome.ps1 -Url https://example.com -NewWindow

.OUTPUTS
    JSON：{ ok, browser, executable, url, pid, newWindow } 或 { ok:false, code, instructions }

.NOTES
    退出码：0 = 已在 Chrome 中打开；2 = 网址非法；3 = 本机没有 Chrome（需用户授权后安装）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Url,

    [switch]$NewWindow,

    [string]$ChromePath = ''
)

$ErrorActionPreference = 'Stop'

function Write-Json {
    param([hashtable]$Payload)
    $Payload | ConvertTo-Json -Compress -Depth 5
}

function Resolve-Chrome {
    param([string]$Explicit)

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Explicit) { $candidates.Add($Explicit) }
    if ($env:CHROME_ONLY_CHROME_PATH) { $candidates.Add($env:CHROME_ONLY_CHROME_PATH) }

    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
    foreach ($root in $roots) {
        if ($root) { $candidates.Add((Join-Path $root 'Google\Chrome\Application\chrome.exe')) }
    }

    foreach ($key in @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
        try {
            $item = Get-ItemProperty -Path $key -ErrorAction Stop
            if ($item.'(default)') { $candidates.Add($item.'(default)') }
        } catch {
            # 该注册表项不存在：继续探测下一个
        }
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).ProviderPath
        }
    }
    return $null
}

function Resolve-Url {
    param([string]$Raw)

    $value = $Raw.Trim()
    if (-not $value) { throw 'EMPTY_URL' }

    if ($value -match '^([a-zA-Z][a-zA-Z0-9+.\-]*):') {
        $scheme = $Matches[1].ToLowerInvariant()
        $allowed = @('http', 'https', 'file', 'about', 'chrome', 'view-source', 'chrome-extension')
        if ($allowed -notcontains $scheme) { throw "UNSUPPORTED_SCHEME:$scheme" }
        return $value
    }

    if ($value -match '^[A-Za-z]:\\' -or $value.StartsWith('\\\\')) {
        $uri = New-Object System.Uri(('file:///' + ($value -replace '\\', '/')))
        return $uri.AbsoluteUri
    }

    return 'https://' + $value
}

$chrome = Resolve-Chrome -Explicit $ChromePath
if (-not $chrome) {
    Write-Json @{
        ok           = $false
        code         = 'CHROME_MISSING'
        browser      = 'Google Chrome (not installed)'
        instructions = '本机未找到 Google Chrome。DSH 规则禁止改用其他浏览器；请先调用 ask_user_question 询问用户是否授权下载安装 Google Chrome，授权后再执行安装。'
    }
    exit 3
}

try {
    $target = Resolve-Url -Raw $Url
} catch {
    Write-Json @{
        ok           = $false
        code         = 'INVALID_URL'
        instructions = $_.Exception.Message
    }
    exit 2
}

$arguments = @()
if ($NewWindow) { $arguments += '--new-window' }
$arguments += $target

$process = Start-Process -FilePath $chrome -ArgumentList $arguments -PassThru
Write-Json @{
    ok         = $true
    browser    = 'Google Chrome'
    executable = $chrome
    url        = $target
    pid        = $process.Id
    newWindow  = [bool]$NewWindow
}
exit 0
