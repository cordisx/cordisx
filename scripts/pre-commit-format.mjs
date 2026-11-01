#!/usr/bin/env node
// Formats exactly what a commit is about to record, so a commit cannot reach
// `dprint check` in CI unformatted.
//
// The staged blob is formatted with `dprint fmt --stdin <path>`, which still
// applies dprint.json's includes and excludes, and the result is written back to
// the index. Working on the index rather than the file is what makes partial
// staging safe: unstaged hunks are never read, staged, stashed or patched back.
// The stash-and-reapply approach cannot do this reliably, because a formatter
// rewrites the very context lines the reapply patch is anchored to.
//
// Only staged paths are formatted, so the cost follows the commit, not the
// repository.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// The extensions dprint.json includes; anything else belongs to someone else.
const INCLUDED = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonc|md|css|scss|sass|less)$/
// Symlinks and submodules (120000, 160000) have no text to format.
const FORMATTABLE_MODES = new Set(['100644', '100755'])

const root = path.resolve(import.meta.dirname, '..')
const dprint = path.join(root, 'node_modules', '.bin', 'dprint')

function git(args, input) {
  const result = spawnSync('git', args, { cwd: root, input, maxBuffer: 256 * 1024 * 1024 })
  if (result.status !== 0) {
    const detail = result.stderr.toString().trim() || `exit code ${result.status}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout
}

function stop(message) {
  console.error(`[hooks] ${message}`)
  process.exit(1)
}

// A checkout without dependencies must still be able to commit.
if (!existsSync(dprint)) {
  console.log('[hooks] dprint is not installed, skipping the pre-commit formatter.')
  process.exit(0)
}

const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
  .toString()
  .split('\0')
  .filter(file => INCLUDED.test(file))

let formatted = 0
for (const file of staged) {
  const [mode, blob, stage] = git(['ls-files', '-s', '--', file]).toString().trim().split(/\s+/)
  if (stage !== '0' || !FORMATTABLE_MODES.has(mode)) continue

  // dprint resolves the configuration that applies from the path itself, so the
  // file has to exist. A path staged while deleted from the working tree is
  // left to the author.
  const filePath = path.join(root, file)
  if (!existsSync(filePath) || !statSync(filePath).isFile()) continue

  const original = git(['cat-file', 'blob', blob])
  const result = spawnSync(dprint, ['fmt', '--stdin', filePath], {
    cwd: root,
    input: original,
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) stop(`${file} could not be formatted: ${result.error.message}`)
  if (result.status !== 0) stop(`${file} could not be formatted: ${result.stderr.toString().trim()}`)
  if (result.stdout.equals(original)) continue

  // Hashing through the path keeps any Git attributes and clean filters that
  // apply to this file in effect.
  const scratch = mkdtempSync(path.join(tmpdir(), 'cordisx-hook-'))
  try {
    const temp = path.join(scratch, 'blob')
    writeFileSync(temp, result.stdout)
    const rewritten = git(['hash-object', '-w', '--path', file, temp]).toString().trim()
    git(['update-index', '--cacheinfo', mode, rewritten, file])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  // Mirror the result into the working tree only when it held exactly what was
  // committed; a partially staged file keeps its unstaged hunks untouched.
  if (readFileSync(filePath).equals(original)) writeFileSync(filePath, result.stdout)
  formatted += 1
}

if (formatted > 0) console.log(`[hooks] formatted ${formatted} staged file${formatted === 1 ? '' : 's'}.`)
