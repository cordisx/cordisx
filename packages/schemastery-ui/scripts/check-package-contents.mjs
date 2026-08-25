import { execFileSync } from 'node:child_process'

const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--workspace=@cordisx/schemastery-ui', '--ignore-scripts'],
  { cwd: new URL('../../..', import.meta.url), encoding: 'utf8' },
)
const [report] = JSON.parse(output)
const files = report?.files?.map(file => file.path)
if (!Array.isArray(files)) throw new Error('npm pack did not report package contents')
for (const required of ['package.json', 'README.md', 'LICENSE', 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md', 'dist/index.js', 'dist/index.d.ts']) {
  if (!files.includes(required)) throw new Error(`@cordisx/schemastery-ui is missing ${required}`)
}
const leaked = files.filter(file => !['package.json', 'README.md', 'LICENSE', 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'].includes(file) && !file.startsWith('dist/'))
if (leaked.length > 0) throw new Error(`@cordisx/schemastery-ui leaked non-allowlisted files: ${leaked.join(', ')}`)
console.log(`[cordisx] @cordisx/schemastery-ui package allowlist verified: ${files.length} files`)
