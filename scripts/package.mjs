import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createPackage, extractFile, listPackage } from '@electron/asar'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = resolve(root, 'dist')
const release = resolve(root, 'release')
const artifacts = resolve(root, 'artifacts')
const plugin = JSON.parse(await readFile(join(dist, 'plugin.json'), 'utf8'))
for (const field of ['name', 'pluginName', 'author', 'version', 'main', 'preload', 'logo']) {
  assert.ok(plugin[field], `缺少插件字段：${field}`)
}
assert.match(plugin.preload, /\.js$/i, 'uTools 开发者工具只接受 .js 后缀的 preload 入口')
assert.equal(JSON.parse(await readFile(join(dist, 'package.json'), 'utf8')).type, 'commonjs')
await Promise.all([mkdir(release, { recursive: true }), mkdir(artifacts, { recursive: true })])
const temporary = await mkdtemp(join(artifacts, 'package-'))
try {
  const archivePath = join(temporary, 'plugin.asar')
  await createPackage(dist, archivePath)
  for (const filename of ['plugin.json', plugin.main, plugin.preload, plugin.logo, 'window-state.cjs', 'windows-acrylic.cjs', 'mcp-tools.cjs', 'repository.cjs']) {
    assert.deepEqual(extractFile(archivePath, filename), await readFile(join(dist, filename)))
  }
  const entries = listPackage(archivePath)
  assert.ok(!entries.some(name => /node_modules|browser-host|\.test\.|\/tests\//.test(name)), '运行包混入了开发文件')
  async function verifyDirectory(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = join(directory, entry.name)
      if (entry.isDirectory()) await verifyDirectory(filename)
      else assert.deepEqual(extractFile(archivePath, relative(dist, filename).split(sep).join('/')), await readFile(filename))
    }
  }
  await verifyDirectory(dist)
  const archive = await readFile(archivePath)
  const packed = gzipSync(archive, { level: 9 })
  assert.deepEqual(gunzipSync(packed), archive)
  const stamp = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace(/[-: ]/g, '')
  const destination = join(release, `quick-note-${plugin.version}-${stamp}.upx`)
  await writeFile(destination, packed, { flag: 'wx' })
  const sha256 = createHash('sha256').update(packed).digest('hex')
  await writeFile(`${destination}.sha256`, `${sha256}\n`, { flag: 'wx' })
  console.log(`插件包：${destination}`)
  console.log(`已逐文件核对 ASAR 与构建目录，大小 ${(packed.length / 1024).toFixed(1)} KB`)
  console.log('此检查不代表已经在 uTools 中安装或完成实机验收。')
} finally {
  assert.ok(resolve(temporary).startsWith(artifacts + sep + 'package-'))
  await rm(temporary, { recursive: true, force: true })
}
