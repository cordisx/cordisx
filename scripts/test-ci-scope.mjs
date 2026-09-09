import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const classifier = path.join(root, 'scripts/ci-scope.sh')

function classify({ initial = {}, changes = {}, rename, remove = [], empty = false, outputFile = true }) {
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
    const outputPath = path.join(cwd, 'outputs')
    const stdout = execFileSync('bash', [classifier], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE_SHA: base,
        HEAD_SHA: git('rev-parse', 'HEAD'),
        GITHUB_OUTPUT: outputFile ? outputPath : '',
        GITHUB_STEP_SUMMARY: '',
      },
    })
    const output = outputFile ? readFileSync(outputPath, 'utf8') : stdout
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

test('CI shares preparation and preserves independent full delivery checks', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/check.yml'), 'utf8')
  assert.equal([...workflow.matchAll(/run: npm ci\n/g)].length, 1)
  assert.match(workflow, /max-parallel: 3/)
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs.scope.outputs.matrix\) \}\}/)
  for (
    const command of ['check:clean-dev', 'typecheck', 'build', 'check:release', 'check:package', 'check:installed']
  ) {
    assert.ok(workflow.includes(`npm run ${command}`), command)
  }
  assert.match(workflow, /args=\(run --project/)
  assert.match(workflow, /--changed "\$BASE_SHA"/)
  assert.match(workflow, /needs: \[scope, changed-quality, prepare, typecheck, tests, package-checks\]/)
  assert.ok(workflow.includes('.result == "success" or .result == "skipped"'))
})

test('standalone classifier writes to a captured stdout pipe', () => {
  assert.equal(classify({ changes: { 'README.md': '# Changed\n' }, outputFile: false }).docs_only, 'true')
})

test('complete jobs honor cancellation so superseded PR runs release their slot', () => {
  const source = readFileSync(new URL('../.github/workflows/check.yml', import.meta.url), 'utf8')
  assert.ok(source.includes('    if: ${{ !cancelled() && '))
  assert.ok(!source.includes('    if: always() && '))
})

for (const file of ['AGENTS.md', '.agents/rules/README.md']) {
  test(`maintenance prose does not launch runtime checks: ${file}`, () => {
    const result = classify({ changes: { [file]: '# Rule\n' } })
    assert.equal(result.full, 'false')
    assert.equal(result.docs_only, 'true')
  })
}

test('service changes do not request Chrome', () => {
  const result = classify({ changes: { 'packages/cli/src/providers/service.ts': 'export {}\n' } })
  assert.equal(result.browser, 'false')
})

test('browser semantics and browser test deletions select the browser group', () => {
  assert.equal(
    classify({ changes: { 'packages/cli/src/renderer/restricted-content/index.ts': 'export {}\n' } }).browser,
    'true',
  )
  assert.equal(
    classify({ initial: { 'tests/example.browser.test.ts': 'test\n' }, remove: ['tests/example.browser.test.ts'] })
      .browser,
    'true',
  )
})

test('lockfile changes select resolved Node consumers and package checks, not full release', () => {
  const result = classify({ changes: { 'package-lock.json': '{}\n' } })
  assert.equal(result.full, 'false')
  assert.equal(result.node_all, 'true')
  assert.equal(result.package_checks, 'true')
})

test('browser dependency updates select browser checks without unrelated service upgrades doing so', () => {
  const manifest = version => JSON.stringify({ dependencies: { react: version } })
  assert.equal(
    classify({ initial: { 'package.json': manifest('1') }, changes: { 'package.json': manifest('2') } }).browser,
    'true',
  )
  assert.equal(
    classify({ changes: { 'package.json': JSON.stringify({ dependencies: { debug: '4' } }) } }).browser,
    'false',
  )
})

test('Playground browser composition selects browser checks', () => {
  assert.equal(classify({ changes: { 'packages/cli/src/playground/vite/server.ts': 'export {}\n' } }).browser, 'true')
})

test('failed-job reruns reuse the successful prepare artifact and evidence retains scope', () => {
  const workflow = readFileSync(path.join(root, '.github/workflows/check.yml'), 'utf8')
  const restore = readFileSync(path.join(root, '.github/actions/restore-prepared-host/action.yml'), 'utf8')
  assert.ok(workflow.includes('name: prepared-host\n'))
  assert.ok(restore.includes('name: prepared-host\n'))
  assert.ok(workflow.includes('overwrite: true'))
  assert.ok(workflow.includes('environment:$environment,groups:$groups,outcomes:$outcomes'))
})
