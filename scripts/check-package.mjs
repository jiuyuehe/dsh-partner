import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
if (!process.argv[2]) throw new Error('Usage: npm run pack:verify -- /path/to/package.tgz')
const archive = resolve(process.argv[2])
const { size } = await stat(archive)
assert.ok(size <= 10_000_000, `Package exceeds 10 MB: ${size} bytes; review bundled assets`)
const { stdout } = await exec('tar', ['-tzf', archive], { maxBuffer: 8 * 1024 * 1024 })
const paths = stdout.trim().split(/\r?\n/)
assert.ok(paths.every(path => path.startsWith('package/') && !path.split('/').includes('..')))
assert.ok(!paths.some(path => path.startsWith('package/resources/skills/novel-game-creation/upstream/examples/')), 'Optional example projects leaked into npm package')
for (const file of ['lib/client.js', 'lib/client.pendant.js', 'lib/pendant-renderer.js', 'lib/index.js', 'cordis.patch.yml', 'lib/inbox/index.js', 'lib/inbox/index.d.ts', 'docs/dev/phase-1-data-model.md', 'docs/releases/2.24.1.md', 'src/inbox/migrations/001-inbox-schema.up.sql', 'src/inbox/migrations/001-inbox-schema.down.sql']) {
  assert.ok(paths.includes('package/' + file), `Missing runtime file: ${file}`)
}
const root = await mkdtemp(join(tmpdir(), 'partner-package-check-'))
try {
  await exec('tar', ['-xzf', archive, '-C', root])
  const packageRoot = join(root, 'package')
  const { loadBuiltinResources } = await import(pathToFileURL(join(packageRoot, 'lib/skills/builtin-resources.js')).href)
  const { BUILTIN_SKILLS } = await import(pathToFileURL(join(packageRoot, 'lib/skills/builtin.js')).href)
  const bundles = [...new Set([...BUILTIN_SKILLS.values()].map(skill => skill.resourceBundle).filter(Boolean))].sort()
  const directories = (await readdir(join(packageRoot, 'resources/skills'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  assert.deepEqual(directories, bundles, 'Packaged resource directories must match the built-in catalog')
  for (const id of bundles) {
    const files = await loadBuiltinResources(id)
    const manifest = JSON.parse(await readFile(join(packageRoot, 'resources/skills', id, 'manifest.json'), 'utf8'))
    assert.equal(files.length, manifest.files.length + 1)
    if (id === 'novel-game-creation') {
      assert.equal(files.filter(file => /^upstream\/skills\/[^/]+\/SKILL.md$/.test(file.path)).length, 7)
      assert.ok(files.some(file => file.path === 'upstream/LICENSE'))
    }
    console.log(`${id}: ${files.length} resources verified from archive`)
  }
  console.log(`Package verified: ${size} bytes (${(size / 1_000_000).toFixed(2)} MB)`)
} finally {
  await rm(root, { recursive: true, force: true })
}
