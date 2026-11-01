import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const source = new URL('./install-git-hooks.mjs', import.meta.url)
const sourceHook = new URL('./hooks/git-hook.sh', import.meta.url)

// env carries the isolated HOME, so no assertion can read this machine's
// global Git configuration.
async function git(cwd, env, ...args) {
  const { stdout } = await exec('git', args, { cwd, env })
  return stdout.trim()
}

// A repository with the installer in place and an isolated HOME, so the
// machine's real global hooksPath never enters the assertions.
async function repository(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cordisx-hooks-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const repo = path.join(root, 'repo')
  await mkdir(path.join(repo, 'scripts', 'hooks'), { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(path.join(repo, 'scripts', 'install-git-hooks.mjs'), await readFile(source))
  await writeFile(path.join(repo, 'scripts', 'hooks', 'git-hook.sh'), await readFile(sourceHook), { mode: 0o755 })
  await exec('git', ['init', '--quiet', repo])
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CI: '', CORDISX_NO_HOOKS: '' }
  return { root, home, repo, env }
}

// stdout and stderr together, because a step-aside is reported as a warning.
async function install(repo, env) {
  const { stdout, stderr } = await exec(process.execPath, ['scripts/install-git-hooks.mjs'], { cwd: repo, env })
  return stdout + stderr
}

async function globalHooks(dir, env) {
  await exec('git', ['config', '--global', 'core.hooksPath', dir], { env })
}

test('installs a pre-commit hook in the Git directory and records nothing to chain without one', async t => {
  const { repo, env } = await repository(t)
  const output = await install(repo, env)

  const hooksPath = await git(repo, env, 'config', '--local', '--get', 'core.hooksPath')
  assert.equal(
    path.resolve(hooksPath),
    path.join(await git(repo, env, 'rev-parse', '--absolute-git-dir'), 'cordisx-hooks'),
  )
  assert.ok(existsSync(path.join(hooksPath, 'pre-commit')), 'pre-commit hook is installed')
  assert.match(output, /formats staged files/)
  await assert.rejects(exec('git', ['config', '--local', '--get', 'cordisx.hooksChainPath'], { cwd: repo }))
})

test('keeps a global hook directory and records it so its pre-commit still runs', async t => {
  const { root, repo, env } = await repository(t)
  const scanned = path.join(root, 'scanner')
  await mkdir(scanned)
  // Mirrors the shape that put this machine's scanner in place: a global
  // hooksPath whose pre-commit is a chain entry point of its own.
  await writeFile(path.join(scanned, 'pre-commit'), '#!/bin/sh\necho scanner-ran\n', { mode: 0o755 })
  await writeFile(path.join(scanned, 'commit-msg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await globalHooks(scanned, env)

  const output = await install(repo, env)

  assert.equal(await git(repo, env, 'config', '--local', '--get', 'cordisx.hooksChainPath'), scanned)
  assert.match(output, new RegExp(`then runs ${scanned.replaceAll('\\', '\\\\')}/pre-commit`))
  const hooksPath = path.resolve(await git(repo, env, 'config', '--local', '--get', 'core.hooksPath'))
  assert.ok(existsSync(path.join(hooksPath, 'commit-msg')), 'a chained hook is forwarded under its own name')
  assert.ok(!existsSync(path.join(hooksPath, 'pre-push')), 'a hook the chain lacks is not invented')
})

test('reinstalling is idempotent and keeps the chain it recorded', async t => {
  const { root, repo, env } = await repository(t)
  const scanned = path.join(root, 'scanner')
  await mkdir(scanned)
  await writeFile(path.join(scanned, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await globalHooks(scanned, env)

  await install(repo, env)
  await install(repo, env)

  assert.equal(await git(repo, env, 'config', '--local', '--get', 'cordisx.hooksChainPath'), scanned)
  const hooksPath = await git(repo, env, 'config', '--local', '--get', 'core.hooksPath')
  assert.equal(
    path.resolve(hooksPath),
    path.join(await git(repo, env, 'rev-parse', '--absolute-git-dir'), 'cordisx-hooks'),
  )
})

test('leaves a local hooksPath this checkout set for something else in place', async t => {
  const { repo, env } = await repository(t)
  await exec('git', ['config', '--local', 'core.hooksPath', '.other-hooks'], { cwd: repo })

  // `npm install` runs this, so a setting it must not change cannot fail it.
  const output = await install(repo, env)

  assert.match(output, /leaving core\.hooksPath at \.other-hooks/)
  assert.equal(await git(repo, env, 'config', '--local', '--get', 'core.hooksPath'), '.other-hooks')
  await assert.rejects(exec('git', ['config', '--local', '--get', 'cordisx.hooksChainPath'], { cwd: repo }))
})

test('does nothing in CI, when disabled, or outside a repository', async t => {
  const { repo, env } = await repository(t)
  await install(repo, { ...env, CI: 'true' })
  await assert.rejects(exec('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo }))
  await install(repo, { ...env, CORDISX_NO_HOOKS: '1' })
  await assert.rejects(exec('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: repo }))

  const outside = await mkdtemp(path.join(tmpdir(), 'cordisx-hooks-plain-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  const { stdout } = await exec(process.execPath, [path.join(repo, 'scripts/install-git-hooks.mjs')], {
    cwd: outside,
    env,
  })
  assert.equal(stdout, '')
})

test('uninstall drops the local override so the machine-wide hook applies again', async t => {
  const { root, repo, env } = await repository(t)
  const scanned = path.join(root, 'scanner')
  await mkdir(scanned)
  await writeFile(path.join(scanned, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await globalHooks(scanned, env)
  await install(repo, env)
  const hooksPath = path.resolve(await git(repo, env, 'config', '--local', '--get', 'core.hooksPath'))

  await exec(process.execPath, ['scripts/install-git-hooks.mjs', '--uninstall'], { cwd: repo, env })

  assert.equal(await git(repo, env, 'config', '--get', 'core.hooksPath'), scanned)
  assert.ok(!existsSync(hooksPath), 'the install directory is gone')
  await assert.rejects(exec('git', ['config', '--local', '--get', 'cordisx.hooksChainPath'], { cwd: repo }))
})

test('a commit formats its staged file and still runs the chained pre-commit hook', async t => {
  const { root, repo, env } = await repository(t)
  const scanned = path.join(root, 'scanner')
  await mkdir(scanned)
  // The machine-wide hook records that it ran, so the test can prove the
  // scanner was not dropped by the override.
  await writeFile(
    path.join(scanned, 'pre-commit'),
    `#!/bin/sh\nprintf 'scanner\\n' >> "${path.join(root, 'ran.log')}"\n`,
    { mode: 0o755 },
  )
  await globalHooks(scanned, env)
  // Stands in for lint-staged: rewrites the staged file and re-stages it, which
  // is what the real task does for the hunks being committed.
  await writeFile(
    path.join(repo, 'scripts/pre-commit-format.mjs'),
    `import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const file = 'app.ts'
writeFileSync(file, readFileSync(file, 'utf8').replace('const x={a:1}', 'const x = { a: 1 }'))
execFileSync('git', ['add', '--', file])
`,
  )
  await writeFile(path.join(repo, 'app.ts'), 'const x={a:1}\n')
  await git(repo, env, 'config', 'user.email', 'test@example.com')
  await git(repo, env, 'config', 'user.name', 'Test')
  await exec('git', ['add', '--', 'app.ts'], { cwd: repo, env })

  await install(repo, env)
  await exec('git', ['commit', '--quiet', '-m', 'probe'], { cwd: repo, env })

  assert.equal(await git(repo, env, 'show', 'HEAD:app.ts'), 'const x = { a: 1 }')
  assert.equal(await readFile(path.join(root, 'ran.log'), 'utf8'), 'scanner\n')
})

test('a failing formatter stops the commit', async t => {
  const { repo, env } = await repository(t)
  await writeFile(path.join(repo, 'scripts/pre-commit-format.mjs'), 'process.exit(1)\n')
  await writeFile(path.join(repo, 'app.ts'), 'const x={a:1}\n')
  await git(repo, env, 'config', 'user.email', 'test@example.com')
  await git(repo, env, 'config', 'user.name', 'Test')
  await exec('git', ['add', '--', 'app.ts'], { cwd: repo, env })
  await install(repo, env)

  await assert.rejects(exec('git', ['commit', '--quiet', '-m', 'probe'], { cwd: repo, env }))
  await assert.rejects(exec('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repo, env }), 'no commit was created')
})
