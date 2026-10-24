// List entries under a directory inside app.asar.
// Usage: node asar-list.mjs <asarPath> <dirPath>
import { readFileSync } from 'node:fs'

const [asarPath, dirPath = ''] = process.argv.slice(2)
const buf = readFileSync(asarPath)
const headerSize = buf.readUInt32LE(4)
const jsonSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize))

let node = header
for (const part of dirPath.split('/').filter(Boolean)) {
  node = node.files?.[part]
  if (!node) {
    console.error(`not found: ${dirPath}`)
    process.exit(1)
  }
}
if (!node.files) {
  console.error(`not a directory: ${dirPath}`)
  process.exit(1)
}
for (const [name, entry] of Object.entries(node.files)) {
  const kind = entry.files ? 'dir ' : 'file'
  const size = entry.files ? '' : String(entry.size).padStart(8)
  console.log(`${kind} ${size}  ${name}`)
}
void headerSize
