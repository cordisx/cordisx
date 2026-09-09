import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { matchesGlob } from 'node:path'
import { test } from 'node:test'
import config from '../vitest.config.mjs'

const root = new URL('..', import.meta.url)
const projects = config.test.projects.map(project => project.test)
const owners = file =>
  projects.filter(project =>
    project.include.some(pattern => matchesGlob(file, pattern))
    && !project.exclude.some(pattern => matchesGlob(file, pattern))
  ).map(project => project.name)

test('every tracked test has exactly one execution group', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')
    .filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.includes('/dist/'))
  assert.ok(files.length > 0)
  for (const file of files) assert.equal(owners(file).length, 1, file)
})

test('browser and costly integration fixtures cannot enter the unit groups', () => {
  assert.deepEqual(owners('tests/plugin-generation-native-browser.test.ts'), ['browser'])
  assert.deepEqual(owners('tests/restricted-content.browser.test.ts'), ['browser'])
  assert.deepEqual(owners('tests/cli-run.integration.test.ts'), ['integration'])
  assert.deepEqual(owners('tests/native-vite-helper-reload.test.ts'), ['integration'])
  assert.deepEqual(owners('tests/manager-content-fill.integration.test.tsx'), ['integration'])
  assert.deepEqual(owners('tests/notifications-ui.test.tsx'), ['renderer'])
  assert.deepEqual(owners('tests/a-new-service.test.ts'), ['core'])
  assert.deepEqual(owners('packages/new/test/new.test.ts'), ['core'])
})

test('default and affected commands do not launch browser or integration groups', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
  assert.equal(scripts.test, 'npm run test:unit')
  for (const name of ['test:unit', 'test:affected']) {
    assert.match(scripts[name], /--project core --project renderer/)
    assert.doesNotMatch(scripts[name], /--project (browser|integration)/)
  }
  assert.match(scripts.check, /npm run test:all/)
  assert.equal(scripts['test:all'], 'vitest run')
})
