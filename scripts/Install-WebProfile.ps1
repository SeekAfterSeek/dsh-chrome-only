<#
.SYNOPSIS
    把 @local/dsh-chrome-only 安装进另一个 DSH profile（默认 `web`），让 `dsh web`
    启动时也改用 Google Chrome，而不是系统默认浏览器。

.DESCRIPTION
    `dsh web`（profile `web`）与桌面应用（profile `desktop`）各有独立的 profile 目录；
    plugin_manager 只管当前 profile，所以这里用与它相同的步骤手工落一次：
      1) package.json dependencies 增加 link: 依赖
      2) dsh.profile.bundles 追加 @local/dsh-chrome-only
      3) 在 profile 目录执行 pnpm install
    重复执行是安全的（已存在就跳过）。

.PARAMETER Profile
    目标 profile 名，默认 web。

.PARAMETER BundlePath
    本插件包目录，默认脚本所在包的上一级。

.NOTES
    需要 pnpm（使用 DeepSeek Harness 自带的 pnpm，无需全局安装）。
#>
[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [string]$BundlePath = ''
)

$ErrorActionPreference = 'Stop'
if (-not $BundlePath) { $BundlePath = Split-Path -Parent $PSScriptRoot }
$bundleName = '@local/dsh-chrome-only'

$homeRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path (Join-Path $homeRoot 'profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDir)) { throw "profile 目录不存在：$profileDir" }

$manifestPath = Join-Path $profileDir 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

$linkTarget = (Resolve-Path -LiteralPath $BundlePath).ProviderPath.Replace('\', '/')
if (-not $manifest.dependencies) {
    $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
if (-not $manifest.dependencies.PSObject.Properties[$bundleName]) {
    $manifest.dependencies | Add-Member -NotePropertyName $bundleName -NotePropertyValue "link:$linkTarget"
    "dependencies += $bundleName -> link:$linkTarget"
} else {
    "dependencies 已含 $bundleName"
}

$bundles = @($manifest.dsh.profile.bundles)
if ($bundles -notcontains $bundleName) {
    $manifest.dsh.profile.bundles = @($bundles + $bundleName)
    "bundles += $bundleName"
} else {
    "bundles 已含 $bundleName"
}

$json = $manifest | ConvertTo-Json -Depth 10
# 必须无 BOM：DSH 读取 profile manifest 时直接 JSON.parse，BOM 会导致启动失败。
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding($false)))
"已更新 $manifestPath"

# 找 DSH 自带的 pnpm：先查常见的安装根，再按 pnpm.mjs 兜底搜索。
$appRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'),
    (Join-Path $env:ProgramFiles 'DeepSeek Harness'),
    (Join-Path ${env:ProgramFiles(x86)} 'DeepSeek Harness')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$pnpmEntry = $null
foreach ($root in $appRoots) {
    $candidate = Join-Path $root 'resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
    if (Test-Path -LiteralPath $candidate) { $pnpmEntry = $candidate; break }
}
if (-not $pnpmEntry) {
    foreach ($root in $appRoots) {
        $found = Get-ChildItem -LiteralPath (Join-Path $root 'resources') -Recurse -Filter 'pnpm.mjs' -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($found) { $pnpmEntry = $found.FullName; break }
    }
}
if (-not $pnpmEntry) { throw '未找到 DeepSeek Harness 自带的 pnpm.mjs；请手动在 profile 目录执行 pnpm install' }

"使用 pnpm：$pnpmEntry"
Push-Location $profileDir
try {
    & node $pnpmEntry install --prefer-offline 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

"完成：profile '$Profile' 已安装 $bundleName"
