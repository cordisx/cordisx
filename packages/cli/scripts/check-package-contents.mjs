import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--workspace=cordisx', '--ignore-scripts'],
  { cwd: repositoryRoot, encoding: 'utf8' },
)
const report = JSON.parse(output)
const files = report[0]?.files?.map(file => file.path)
if (!Array.isArray(files)) throw new Error('npm pack did not report package contents')

const leaked = files.filter(file => file !== 'package.json' && !file.startsWith('dist/'))
if (leaked.length > 0) throw new Error(`cordisx package leaked non-allowlisted files: ${leaked.join(', ')}`)

for (const required of [
  'dist/src/cli.js',
  'dist/src/contracts.js',
  'dist/src/contracts.d.ts',
  'dist/assets/brand/cordisx-mark-light.svg',
  'dist/assets/brand/cordisx-mark-dark.svg',
]) {
  if (!files.includes(required)) throw new Error(`cordisx package is missing ${required}`)
}

console.log(`[cordisx] package allowlist verified: ${files.length} files`)
