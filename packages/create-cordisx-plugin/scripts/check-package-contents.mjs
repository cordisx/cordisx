import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--workspace=create-cordisx-plugin', '--ignore-scripts'],
  { cwd: repositoryRoot, encoding: 'utf8' },
)
const report = JSON.parse(output)
const files = report[0]?.files?.map(file => file.path)
if (!Array.isArray(files)) throw new Error('npm pack did not report package contents')

const allowedRoots = ['CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md', 'LICENSE', 'README.md', 'package.json']
const leaked = files.filter(file => (
  !allowedRoots.includes(file) && !file.startsWith('dist/') && !file.startsWith('template/')
))
if (leaked.length > 0) {
  throw new Error(`create-cordisx-plugin package leaked non-allowlisted files: ${leaked.join(', ')}`)
}

for (const required of [
  'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md',
  'LICENSE',
  'README.md',
  'dist/cli.js',
  'template/README.md',
  'template/_gitignore',
  'template/package.json',
  'template/src/{{packageName}}.ts',
  'template/test/manifest.mjs',
  'template/tsconfig.json',
]) {
  if (!files.includes(required)) throw new Error(`create-cordisx-plugin package is missing ${required}`)
}

console.log(`[create-cordisx-plugin] package allowlist verified: ${files.length} files`)
