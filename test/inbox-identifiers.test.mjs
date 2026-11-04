import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

test('SessionId, RunId, SubagentId and JobId reject cross-domain assignments at compile time', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const compiler = resolve(root, 'node_modules/typescript/bin/tsc')
  const fixture = resolve(root, 'test/inbox-identifiers.fixture.ts')
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})
