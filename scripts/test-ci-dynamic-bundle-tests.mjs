import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const selector = fileURLToPath(new URL('./ci-dynamic-bundle-tests.mjs', import.meta.url))
const manager = 'packages/cli/src/renderer/manager/ManagerApp.tsx'
const fixture = 'tests/settings-tab-demo.integration.test.ts'

function selected(change) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cordisx-dynamic-selection-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const write = (file, content) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    writeFileSync(path.join(cwd, file), content)
  }
  try {
    git('init', '-q')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    write(manager, 'old')
    write('packages/cli/src/cli.ts', 'old')
    git('add', '.')
    git('commit', '-qm', 'base')
    const base = git('rev-parse', 'HEAD')
    change({ git, write })
    git('add', '-A')
    git('commit', '-qm', 'change')
    const head = git('rev-parse', 'HEAD')
    const run = project =>
      execFileSync('node', [selector, base, head, project], { cwd }).toString().split('\0').filter(Boolean)
    return { integration: run('integration'), core: run('core') }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('Manager source selects the runtime bundled integration consumer', () => {
  assert.deepEqual(selected(({ write }) => write(manager, 'new')), { integration: [fixture], core: [] })
})

test('unrelated CLI source leaves dynamic selection empty', () => {
  assert.deepEqual(selected(({ write }) => write('packages/cli/src/cli.ts', 'new')), { integration: [], core: [] })
})

test('Manager deletion and rename include the old path', () => {
  assert.deepEqual(selected(({ git }) => git('rm', manager)).integration, [fixture])
  assert.deepEqual(
    selected(({ git, write }) => {
      write('packages/cli/src/cli/.keep', '')
      git('mv', manager, 'packages/cli/src/cli/old-manager.tsx')
    }).integration,
    [fixture],
  )
})
