import assert from 'node:assert/strict'
import { internals } from '../index.js'

const blocked = [
  'Start-Process msedge https://example.com',
  'start https://example.com',
  'Start-Process "https://example.com"',
  'Invoke-Item https://example.com',
  'rundll32 url.dll,FileProtocolHandler https://example.com',
  'explorer.exe "https://example.com"',
  'cmd /c start https://example.com',
  'firefox https://example.com',
  '& "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" https://x.test',
  'microsoft-edge:https://example.com',
  'Start-Process "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" "https://x.test"',
  'xdg-open https://example.com',
  'open https://example.com',
  'powershell -c "Start-Process \'https://x.test\'"',
  '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"',
  'firefox',
  '"firefox" --new-window',
]

const allowed = [
  'echo hello',
  'Get-Process chrome',
  '& "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "https://example.com"',
  'Start-Process "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" "https://example.com"',
  'start chrome https://example.com',
  'npm run build',
  'python -m http.server 8000',
  'Get-ChildItem C:\\Users',
  'node scripts/build.mjs --target edge',
  'Test-Path "C:\\Program Files\\Mozilla Firefox\\firefox.exe"',
  'foreach($p in @("C:\\Program Files\\Mozilla Firefox\\firefox.exe","C:\\x\\msedge.exe")){ Test-Path $p }',
  'Get-ItemProperty \'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe\'',
  'Get-Process chrome, msedge',
  'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe"',
  '$p="$env:ProgramFiles\\Mozilla Firefox\\firefox.exe"; "firefox present: " + (Test-Path $p)',
  'Write-Output "firefox is not installed - using chrome instead"',
  'Get-Content C:\\logs\\msedge-crash.log',
]

let failures = 0
for (const text of blocked) {
  const result = internals.findForbiddenBrowserOpen(text)
  if (!result) {
    failures++
    console.error('MISSED (should block):', text)
  }
}
for (const text of allowed) {
  const result = internals.findForbiddenBrowserOpen(text)
  if (result) {
    failures++
    console.error(`FALSE POSITIVE (${result.browser}):`, text)
  }
}

assert.equal(internals.normalizeUrl('example.com'), 'https://example.com')
assert.equal(internals.normalizeUrl('https://a.test/x'), 'https://a.test/x')
assert.equal(internals.normalizeUrl('C:\\tmp\\a.html'), 'file:///C:/tmp/a.html')
assert.equal(internals.normalizeUrl('about:blank'), 'about:blank')
assert.throws(() => internals.normalizeUrl('javascript:alert(1)'))
assert.throws(() => internals.normalizeUrl('data:text/html,hi'))
assert.throws(() => internals.normalizeUrl('   '))

console.log(internals.locateChromeSync({ chromePath: '' }) ?? '<no chrome on this host>')
console.log(failures === 0 ? 'ALL MATCHER TESTS PASSED' : `${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
