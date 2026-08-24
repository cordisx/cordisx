import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { npmPackItem } from '../../../scripts/npm-pack-report.mjs'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--workspace=cordisx', '--ignore-scripts'],
  { cwd: repositoryRoot, encoding: 'utf8' },
)
const report = JSON.parse(output)
const files = npmPackItem(report, 'cordisx').files?.map(file => file.path)
if (!Array.isArray(files)) throw new Error('npm pack did not report package contents')

const allowedRoots = [
  'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
]
const leaked = files.filter(file => (
  !allowedRoots.includes(file) && !file.startsWith('dist/') && !file.startsWith('third_party/')
))
if (leaked.length > 0) throw new Error(`cordisx package leaked non-allowlisted files: ${leaked.join(', ')}`)

for (const required of [
  'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'third_party/material-symbols-APACHE-2.0.txt',
  'dist/src/cli.js',
  'dist/src/contracts.js',
  'dist/src/contracts.d.ts',
  'dist/src/plugins/cli-proxy-api/README.md',
  'dist/assets/brand/cordisx-mark-light.svg',
  'dist/assets/brand/cordisx-mark-dark.svg',
]) {
  if (!files.includes(required)) throw new Error(`cordisx package is missing ${required}`)
}

console.log(`[cordisx] package allowlist verified: ${files.length} files`)
