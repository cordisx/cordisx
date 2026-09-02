import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
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
const bundledSchemasteryUi = 'node_modules/@cordisx/schemastery-ui/'
const leaked = files.filter(file => (
  !allowedRoots.includes(file) && !file.startsWith('dist/') && !file.startsWith('third_party/') && !file.startsWith(bundledSchemasteryUi)
))
if (leaked.length > 0) throw new Error(`cordisx package leaked non-allowlisted files: ${leaked.join(', ')}`)

const harnessLeak = files.filter(file => /connector-(?:production|harness)/i.test(file))
if (harnessLeak.length > 0) throw new Error(`cordisx package leaked Connector smoke harness artifacts: ${harnessLeak.join(', ')}`)

const harnessPattern = /connector-(?:production|harness)|installConnectorProductionFixture/i
const bundledHarness = []
const distRoot = path.join(repositoryRoot, 'packages/cli/dist')
const scanDistribution = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) scanDistribution(target)
    else if ((entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) && harnessPattern.test(readFileSync(target, 'utf8'))) {
      bundledHarness.push(path.relative(repositoryRoot, target))
    }
  }
}
if (existsSync(distRoot)) scanDistribution(distRoot)
if (bundledHarness.length > 0) throw new Error(`cordisx distribution contains a Connector smoke harness enable path: ${bundledHarness.join(', ')}`)

for (const required of [
  'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'third_party/reicon-MIT.txt',
  'third_party/reicon-icon-credits.txt',
  'third_party/tdesign-web-components-subset-MIT.txt',
  'dist/src/cli.js',
  'dist/src/contracts.js',
  'dist/src/contracts.d.ts',
  'dist/src/plugins/cli-proxy-api/README.md',
  'dist/src/plugins/cli-proxy-api/README.zh-Hans.md',
  'dist/src/plugins/channel/README.md',
  'dist/src/plugins/channel/README.zh-Hans.md',
  'dist/src/plugins/channel/service.mjs',
  'dist/assets/brand/cordisx-mark-light.svg',
  'dist/assets/brand/cordisx-mark-dark.svg',
  'dist/assets/brand/cordisx-mark-animated-light.svg',
  'dist/assets/brand/cordisx-mark-animated-dark.svg',
  'node_modules/@cordisx/schemastery-ui/package.json',
  'node_modules/@cordisx/schemastery-ui/LICENSE',
  'node_modules/@cordisx/schemastery-ui/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'node_modules/@cordisx/schemastery-ui/dist/index.js',
  'node_modules/@cordisx/schemastery-ui/dist/index.d.ts',
]) {
  if (!files.includes(required)) throw new Error(`cordisx package is missing ${required}`)
}

console.log(`[cordisx] package allowlist verified: ${files.length} files`)
