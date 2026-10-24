// Scan an Electron app.asar for keywords without extracting everything.
// Usage: node asar-scan.mjs <asarPath> <keyword> [keyword...]
import { readFileSync } from 'node:fs'

const [asarPath, ...keywords] = process.argv.slice(2)
if (!asarPath || keywords.length === 0) {
  console.error('usage: node asar-scan.mjs <app.asar> <keyword>...')
  process.exit(2)
}

const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(4)
const jsonSize = buf.readUInt32LE(12)
const headerJson = buf.toString('utf8', 16, 16 + jsonSize)
const header = JSON.parse(headerJson)
// headerSize is the total size of the header block (8 + 4 + 4 + jsonSize rounded)
const dataStart = 8 + headerSize

const files = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const p = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, p)
    else if (entry.offset !== undefined) files.push({ path: p, offset: Number(entry.offset), size: Number(entry.size) })
  }
}
walk(header, '')

console.log(`files=${files.length} dataStart=${dataStart} bytes=${buf.length}`)

for (const keyword of keywords) {
  const needle = Buffer.from(keyword, 'utf8')
  let index = 0
  const hits = new Map()
  while (true) {
    index = buf.indexOf(needle, index)
    if (index < 0) break
    const rel = index - dataStart
    const file = files.find((f) => rel >= f.offset && rel < f.offset + f.size)
    if (file) {
      if (!hits.has(file.path)) hits.set(file.path, 0)
      hits.set(file.path, hits.get(file.path) + 1)
    }
    index += needle.length
  }
  const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
  console.log(`\n### ${keyword} (${hits.size} files)`)
  for (const [p, n] of sorted) console.log(`  ${n}\t${p}`)
}
