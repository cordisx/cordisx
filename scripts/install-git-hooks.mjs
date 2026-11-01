#!/usr/bin/env node
// Installs this checkout's pre-commit formatter without losing an existing hook.
//
// Git stops reading .git/hooks entirely once core.hooksPath is set, and this
// machine sets it globally, so the hook goes in a directory of its own and the
// hooks directory it replaced is recorded in cordisx.hooksChainPath for
// scripts/hooks/git-hook.sh to run afterwards.
//
// The install lives in the Git directory, which Git already shares between the
// repository's worktrees: it survives branch switches, including branches
// written before this file existed. The hooks are copies rather than links to a
// checkout, so removing a worktree cannot leave a dangling hook that Git skips
// and that would take the machine-wide hook down with it.
//
// Run by `npm run hooks:install`, which `npm run prepare` calls, so every
// contributor gets it from `npm install`. CI checkouts, a directory that is not
// a repository, and CORDISX_NO_HOOKS=1 are left untouched.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const HOOKS_DIR_NAME = 'cordisx-hooks'
const CHAIN_KEY = 'cordisx.hooksChainPath'
// Hook names Git runs. The chain directory only keeps the ones it has, so a
// machine-wide installer that ships a subset is forwarded exactly as before.
const HOOK_NAMES = [
  'applypatch-msg',
  'commit-msg',
  'fsmonitor-watchman',
  'post-applypatch',
  'post-checkout',
  'post-commit',
  'post-merge',
  'post-rewrite',
  'post-update',
  'pre-applypatch',
  'pre-auto-gc',
  'pre-commit',
  'pre-merge-commit',
  'pre-push',
  'pre-rebase',
  'pre-receive',
  'prepare-commit-msg',
  'push-to-checkout',
  'sendemail-validate',
  'update',
]
const uninstall = process.argv.includes('--uninstall')

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

function stop(message) {
  console.error(`[hooks] ${message}`)
  process.exit(1)
}

// The hooks directory this install replaced: the machine-wide settings it
// overrides, or the directory a previous install recorded as its chain.
function upstreamHooksDirs(cwd) {
  const dirs = []
  for (const scope of ['--system', '--global']) {
    const value = git(cwd, ['config', scope, '--get', 'core.hooksPath'])
    if (value) dirs.push(path.resolve('/', value))
  }
  const previous = git(cwd, ['config', '--local', '--get', CHAIN_KEY])
  if (previous) dirs.push(previous)
  return dirs
}

function hookNamesIn(dir) {
  try {
    return new Set(readdirSync(dir))
  } catch {
    return new Set()
  }
}

if (process.env.CI || process.env.CORDISX_NO_HOOKS) process.exit(0)

const cwd = process.cwd()
const root = git(cwd, ['rev-parse', '--show-toplevel'])
// Covers both "not a repository" and "$GIT_DIR/hooks when installed globally".
if (!root) process.exit(0)

const commonDir = git(cwd, ['rev-parse', '--git-common-dir'])
const hooksDir = path.join(path.resolve(root, commonDir), HOOKS_DIR_NAME)
const localHooksPath = git(cwd, ['config', '--local', '--get', 'core.hooksPath'])
const installed = localHooksPath && path.resolve(root, localHooksPath) === hooksDir

// A local setting pointing elsewhere was chosen by this checkout, and replacing
// it silently would drop whatever it runs. `npm install` must not fail over it,
// so the install steps aside and names the command that resolves it.
if (localHooksPath && !installed) {
  console.warn(
    `[hooks] leaving core.hooksPath at ${localHooksPath}; it already runs this checkout's hooks. `
      + 'Unset it and rerun `npm run hooks:install` to format commits as well.',
  )
  process.exit(0)
}

if (uninstall) {
  if (installed) git(cwd, ['config', '--local', '--unset', 'core.hooksPath'])
  git(cwd, ['config', '--local', '--unset-all', CHAIN_KEY])
  rmSync(hooksDir, { recursive: true, force: true })
  console.log('[hooks] pre-commit formatter uninstalled.')
  process.exit(0)
}

const source = path.join(root, 'scripts', 'hooks', 'git-hook.sh')
if (!existsSync(source)) stop('scripts/hooks/git-hook.sh is missing; run `npm install` from a complete checkout.')

const chain = upstreamHooksDirs(cwd)
  .filter(dir => path.resolve(dir) !== hooksDir)
  .at(-1)
const chained = hookNamesIn(chain)
const forwarded = HOOK_NAMES.filter(name => name === 'pre-commit' || chained.has(name))

mkdirSync(hooksDir, { recursive: true })
const contents = readFileSync(source)
for (const name of HOOK_NAMES) {
  const target = path.join(hooksDir, name)
  if (forwarded.includes(name)) {
    writeFileSync(target, contents, { mode: 0o755 })
    chmodSync(target, 0o755)
  } else {
    rmSync(target, { force: true })
  }
}

git(cwd, ['config', '--local', 'core.hooksPath', hooksDir])
if (chained.has('pre-commit')) git(cwd, ['config', '--local', CHAIN_KEY, chain])
else git(cwd, ['config', '--local', '--unset-all', CHAIN_KEY])

console.log(
  chained.has('pre-commit')
    ? `[hooks] pre-commit formats staged files, then runs ${path.join(chain, 'pre-commit')}.`
    : '[hooks] pre-commit formats staged files.',
)
