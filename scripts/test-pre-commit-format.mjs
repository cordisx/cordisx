import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const script = new URL('./pre-commit-format.mjs', import.meta.url)

// The script runs from a checkout and shells out to the installed dprint, so a
// scratch repository with a stand-in binary keeps these tests independent of
// the real formatter version and of this machine's Git configuration.
const STAND_IN_DPRINT = `#!/usr/bin/env node
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.includes('FAIL')) {
    process.stderr.write('cannot format this file')
    process.exit(1)
  }
  // Upper-casing pretends the formatter rewrote the file, so a test can tell
  // its output was recorded.
  process.stdout.write(text.toUpperCase())
})
`

async function git(cwd, ...args) {
  const { stdout } = await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  return stdout.trim()
}

// Blob content compared byte for byte, because a lost trailing newline is
// exactly the kind of damage this script must not cause.
async function blob(cwd, rev) {
  const { stdout } = await exec('git', ['show', rev], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  return stdout
}

async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cordisx-format-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true })
  await writeFile(path.join(root, 'scripts', 'pre-commit-format.mjs'), await readFile(script))
  await writeFile(path.join(root, 'node_modules', '.bin', 'dprint'), STAND_IN_DPRINT, { mode: 0o755 })
  await exec('git', ['init', '--quiet', root])
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test')
  return root
}

async function format(root) {
  const { stdout } = await exec(process.execPath, ['scripts/pre-commit-format.mjs'], { cwd: root })
  return stdout
}

test('rewrites the staged content and keeps the working tree in step', async t => {
  const root = await repository(t)
  await writeFile(path.join(root, 'app.ts'), 'const a = 1\n')
  await git(root, 'add', '--', 'app.ts')

  const output = await format(root)

  assert.equal(await blob(root, ':app.ts'), 'CONST A = 1\n')
  assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'CONST A = 1\n')
  assert.match(output, /formatted 1 staged file/)
})

test('leaves unstaged hunks of a partially staged file alone', async t => {
  const root = await repository(t)
  await writeFile(path.join(root, 'app.ts'), 'first\n')
  await git(root, 'add', '--', 'app.ts')
  // Second line exists only in the working tree, so it must not be committed
  // and must not be overwritten by the formatter.
  await writeFile(path.join(root, 'app.ts'), 'first\nunstaged\n')

  await format(root)

  assert.equal(await blob(root, ':app.ts'), 'FIRST\n')
  assert.equal(await readFile(path.join(root, 'app.ts'), 'utf8'), 'first\nunstaged\n')
})

test('ignores files dprint does not format and files staged while deleted', async t => {
  const root = await repository(t)
  await writeFile(path.join(root, 'notes.txt'), 'leave me\n')
  await writeFile(path.join(root, 'gone.ts'), 'bye\n')
  await git(root, 'add', '--', 'notes.txt', 'gone.ts')
  await rm(path.join(root, 'gone.ts'))

  const output = await format(root)

  assert.equal(await blob(root, ':notes.txt'), 'leave me\n')
  assert.equal(await blob(root, ':gone.ts'), 'bye\n')
  assert.equal(output, '')
})

test('stops the commit when the formatter fails', async t => {
  const root = await repository(t)
  await writeFile(path.join(root, 'app.ts'), 'FAIL\n')
  await git(root, 'add', '--', 'app.ts')

  await assert.rejects(format(root), /could not be formatted/)
  assert.equal(await blob(root, ':app.ts'), 'FAIL\n')
})

test('commits without dependencies by skipping the formatter', async t => {
  const root = await repository(t)
  await rm(path.join(root, 'node_modules'), { recursive: true, force: true })

  const output = await format(root)

  assert.match(output, /dprint is not installed, skipping/)
})
