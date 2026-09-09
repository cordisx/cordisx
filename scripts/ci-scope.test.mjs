import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const classifier = path.join(root, 'scripts/ci-scope.sh')

function classify({ initial = {}, changes = {}, rename, remove = [], empty = false }) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'cordisx-ci-scope-'))
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const write = files => {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
      writeFileSync(path.join(cwd, file), content)
    }
  }
  try {
    git('init', '--quiet')
    git('config', 'user.name', 'CI scope test')
    git('config', 'user.email', 'ci@example.invalid')
    write({ 'README.md': '# Example\n', ...initial })
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    const base = git('rev-parse', 'HEAD')
    write(changes)
    if (rename) {
      mkdirSync(path.dirname(path.join(cwd, rename[1])), { recursive: true })
      git('mv', '--', ...rename)
    }
    for (const file of remove) git('rm', '--quiet', '--', file)
    if (!empty) {
      git('add', '.')
      git('commit', '--quiet', '-m', 'change')
    }
    const output = execFileSync('bash', [classifier], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: git('rev-parse', 'HEAD'),
        GITHUB_OUTPUT: '/dev/stdout',
        GITHUB_STEP_SUMMARY: '',
      },
    })
    return Object.fromEntries(output.trim().split('\n').map(line => line.split('=')))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('Host guides use the documentation gate', () => {
  const result = classify({ changes: { '.agents/docs/native-debugging-runbook.md': '# Guide\n' } })
  assert.equal(result.full, 'false')
  assert.equal(result.docs_only, 'true')
})

test('PR 389 content selects documentation plus shipped Skill checks', () => {
  const result = classify({
    changes: {
      '.agents/docs/native-debugging-runbook.md': '# Guide\n',
      'skills/cordisx-plugin-development/SKILL.md': '# Skill\n',
      'skills/cordisx-plugin-development/references/live-plugin-development.md': '# Guide\n',
      'skills/cordisx-plugin-development/agents/openai.yaml': 'interface: {}\n',
      'skills/cordisx-plugin-development/version.json': '{"version":"test"}\n',
    },
  })
  assert.equal(result.full, 'false')
  assert.equal(result.docs_only, 'true')
  assert.equal(result.skill_changed, 'true')
})

for (
  const file of [
    '.agents/rules/README.md',
    'AGENTS.md',
    'package-lock.json',
    'packages/cli/src/launcher/main.ts',
    'packages/cli/src/renderer/permission-state.ts',
    'packages/channel-runtime/src/index.ts',
    'tsconfig.json',
    'packages/cli/tsconfig.json',
    'vitest.config.ts',
    'eslint.config.mjs',
    'dprint.json',
    'stylelint.config.mjs',
    'packages/cli/src/agent-tools.ts',
    'skills/cordisx-plugin-development/scripts/example.js',
  ]
) {
  test(`sensitive/configuration path retains full gate: ${file}`, () => {
    assert.equal(classify({ changes: { [file]: 'new\n', 'README.md': '# Changed\n' } }).full, 'true')
  })
}

test('ordinary CLI source retains the affected dependency closure', () => {
  const result = classify({ changes: { 'packages/cli/src/renderer/toolbar.ts': 'export {}\n' } })
  assert.equal(result.full, 'false')
  assert.equal(result.docs_only, 'false')
  assert.equal(result.cli_only, 'true')
})

test('deleting a sensitive file alongside docs cannot bypass full checks', () => {
  assert.equal(
    classify({
      initial: { 'packages/cli/src/launcher/main.ts': 'export {}\n' },
      remove: ['packages/cli/src/launcher/main.ts'],
      changes: { 'README.md': '# Changed\n' },
    }).full,
    'true',
  )
})

test('both ends of a rename affect the classification', () => {
  assert.equal(
    classify({
      initial: { 'packages/cli/src/launcher/old.ts': 'export {}\n' },
      rename: ['packages/cli/src/launcher/old.ts', '.agents/docs/moved.md'],
    }).full,
    'true',
  )
  assert.equal(
    classify({
      initial: { '.agents/docs/old.md': 'export {}\n' },
      rename: ['.agents/docs/old.md', 'packages/cli/src/launcher/new.ts'],
    }).full,
    'true',
  )
})

test('deleting a Skill asset still runs its package completeness checks', () => {
  const result = classify({
    initial: { 'skills/cordisx-plugin-development/SKILL.md': '# Skill\n' },
    remove: ['skills/cordisx-plugin-development/SKILL.md'],
  })
  assert.equal(result.skill_changed, 'true')
  assert.equal(result.full, 'false')
})

test('whitespace and newline paths remain single records', () => {
  assert.equal(classify({ changes: { '.agents/docs/two words\nlauncher.md': '# Guide\n' } }).docs_only, 'true')
})

test('empty diff fails closed to the full gate', () => {
  assert.equal(classify({ empty: true }).full, 'true')
})

test('CI full phases retain the exact complete owner command sequence', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/check.yml'), 'utf8')
  const full = workflow.split('\n  full:\n')[1].split('\n  skill-package:\n')[0]
  const phases = [...full.matchAll(/run: (npm (?:run [\w:-]+|test))$/gm)].map(match => match[1])
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.deepEqual(phases, manifest.scripts.check.split(' && '))
  assert.ok(full.includes("needs.scope.result != 'success'"))
  assert.ok(workflow.includes('run: node --test scripts/ci-scope.test.mjs'))
})
