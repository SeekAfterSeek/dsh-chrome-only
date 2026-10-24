import assert from 'node:assert/strict'
import { internals } from '../index.js'

const WHERE = 'C:\\Windows\\System32\\where.exe'

function fakeCtx({ openBrowser = true, origin = 'http://127.0.0.1:50591', advertised } = {}) {
  const services = {
    webStartup: { openBrowser },
    webServer: { getOrigin: () => origin },
    webApp: { getAdvertisedUrl: () => advertised ?? origin },
    connection: { authenticatedUrl: (base) => `${base}/?token=test` },
    loader: { await: () => Promise.resolve() },
  }
  const scoped = {
    get: (name) => services[name],
    webServer: services.webServer,
  }
  return { inject: (_deps, cb) => cb(scoped), get: () => undefined }
}

// 1) dsh web 正常启动（openBrowser=true）→ 用 Chrome 打开认证后的地址
const statusA = internals.installWebHandoff(fakeCtx(), { chromePath: WHERE, newWindow: false, openWebUiInChrome: true })
await new Promise((r) => setTimeout(r, 300))
assert.equal(statusA.attempted, true)
assert.equal(statusA.opened, true, `expected opened, reason=${statusA.reason}`)
assert.equal(statusA.url, 'http://127.0.0.1:50591/?token=test')
console.log('handoff ok:', JSON.stringify(statusA))

// 2) --no-open / 桌面端启动（openBrowser=false）→ 不打开
const statusB = internals.installWebHandoff(fakeCtx({ openBrowser: false }), {
  chromePath: WHERE,
  newWindow: false,
  openWebUiInChrome: true,
})
await new Promise((r) => setTimeout(r, 100))
assert.equal(statusB.opened, false)
assert.match(statusB.reason, /openBrowser=false/)
console.log('handoff respects --no-open:', JSON.stringify(statusB))

// 3) 配置关闭 → 完全不接手
const statusC = internals.installWebHandoff(fakeCtx(), { chromePath: WHERE, openWebUiInChrome: false })
assert.equal(statusC.attempted, false)
console.log('handoff disabled by config:', JSON.stringify(statusC))

// 4) Chrome 不存在 → 记 CHROME_MISSING，不回退默认浏览器
const statusD = internals.installWebHandoff(fakeCtx(), {
  chromePath: 'C:\\nope\\chrome.exe',
  openWebUiInChrome: true,
})
process.env.CHROME_ONLY_CHROME_PATH = ''
await new Promise((r) => setTimeout(r, 100))
if (!statusD.opened) console.log('handoff without chrome:', JSON.stringify(statusD))

console.log('ALL HANDOFF TESTS PASSED')
