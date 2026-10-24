// Extract one file from app.asar to stdout or a target path.
// Usage: node asar-extract.mjs <asarPath> <innerPath> [outPath]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [asarPath, innerPath, outPath] = process.argv.slice(2)
if (!asarPath || !innerPath) {
  console.error('usage: node asar-extract.mjs <app.asar> <innerPath> [outPath]')
  process.exit(2)
}

const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(4)
const jsonSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize))
const dataStart = 8 + headerSize

const parts = innerPath.split('/').filter(Boolean)
let node = header
for (const part of parts) {
  node = node.files?.[part]
  if (!node) {
    console.error(`not found: ${innerPath}`)
    process.exit(1)
  }
}
if (node.files || node.offset === undefined) {
  console.error(`not a file: ${innerPath}`)
  process.exit(1)
}

const content = buf.subarray(dataStart + Number(node.offset), dataStart + Number(node.offset) + Number(node.size))
if (!outPath) process.stdout.write(content)
else {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, content)
  console.log(`${outPath} (${content.length} bytes)`)
}
void join
