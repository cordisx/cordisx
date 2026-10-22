import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const filter = fileURLToPath(new URL('./ci-filter-dynamic-bundle-tests.mjs', import.meta.url))
const fixture = 'tests/settings-tab-demo.integration.test.ts'

function run(report) {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'cordisx-filter-selection-')))
  try {
    writeFileSync(path.join(cwd, 'selected'), `${fixture}\0`)
    const resolvedReport = structuredClone(report)
    if (Array.isArray(resolvedReport.testResults)) {
      for (const result of resolvedReport.testResults) {
        if (result.name === fixture) result.name = path.join(cwd, fixture)
      }
    }
    writeFileSync(path.join(cwd, 'report.json'), JSON.stringify(resolvedReport))
    return execFileSync('node', [filter, 'report.json', 'selected'], { cwd }).toString()
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('a completed mapped fixture is not run twice, including when it failed', () => {
  for (const status of ['passed', 'failed']) {
    assert.equal(run({ testResults: [{ name: fixture, assertionResults: [{ status }] }] }), '')
  }
})

test('a fixture missing from the ordinary report is selected', () => {
  assert.equal(run({ testResults: [] }), `${fixture}\0`)
})

test('a fixture with only skipped or todo assertions remains selected', () => {
  for (const status of ['pending', 'skipped', 'todo']) {
    assert.equal(run({ testResults: [{ name: fixture, assertionResults: [{ status }] }] }), `${fixture}\0`)
  }
})

test('an invalid report fails rather than silently omitting the fixture', () => {
  assert.throws(() => run({ testResults: 'bad' }))
})
