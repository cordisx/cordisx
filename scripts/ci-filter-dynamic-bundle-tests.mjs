import { readFileSync } from 'node:fs'
import path from 'node:path'

const [reportFile, selectedFile] = process.argv.slice(2)
if (!reportFile || !selectedFile) throw new Error('usage: ci-filter-dynamic-bundle-tests.mjs REPORT SELECTED')

const selected = readFileSync(selectedFile).toString('utf8').split('\0').filter(Boolean)
const report = JSON.parse(readFileSync(reportFile, 'utf8'))
if (!Array.isArray(report.testResults)) throw new Error('Vitest JSON report has no testResults array')
const completed = new Set()
for (const result of report.testResults) {
  if (typeof result.name !== 'string' || !Array.isArray(result.assertionResults)) {
    throw new Error('Vitest JSON report has an invalid test result')
  }
  // A test file that started but did not complete must be rerun.
  if (result.assertionResults.some(assertion => ['passed', 'failed'].includes(assertion.status))) {
    completed.add(path.resolve(result.name))
  }
}
for (const test of selected) {
  if (!completed.has(path.resolve(test))) process.stdout.write(`${test}\0`)
}
