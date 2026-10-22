import { execFileSync } from 'node:child_process'

const [base, head, project] = process.argv.slice(2)
if (!base || !head || !project) throw new Error('usage: ci-dynamic-bundle-tests.mjs BASE HEAD PROJECT')

// These tests build renderer entry points at runtime, outside Vitest's import graph.
const consumers = [
  {
    project: 'integration',
    source: 'packages/cli/src/renderer/manager/',
    test: 'tests/settings-tab-demo.integration.test.ts',
  },
]

const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`])
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
const selected = new Set()
for (const consumer of consumers) {
  if (consumer.project === project && paths.some(file => file.startsWith(consumer.source))) {
    selected.add(consumer.test)
  }
}
for (const test of selected) process.stdout.write(`${test}\0`)
