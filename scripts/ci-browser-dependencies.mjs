import { execFileSync } from 'node:child_process'

// Browser behavior can change through dependencies without a renderer source diff.
const browserPackages = new Set([
  '@cordisx/protocol',
  '@cordisx/schemastery-ui',
  'react',
  'react-dom',
  'vite',
  'vitest',
  'esbuild',
  'lightningcss',
  'jsdom',
  'happy-dom',
  'playwright',
  'puppeteer',
])
function snapshot(ref) {
  const names = execFileSync('git', ['ls-tree', '-r', '--name-only', ref], { encoding: 'utf8' })
    .split('\n').filter(file =>
      file === 'package.json' || file === 'package-lock.json' || /^packages\/[^/]+\/package.json$/.test(file)
    )
  const result = {}
  for (const file of names) {
    const data = JSON.parse(
      execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
    )
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'overrides']) {
      for (const [name, value] of Object.entries(data[section] ?? {})) {
        if (browserPackages.has(name)) result[`${file}:${section}:${name}`] = value
      }
    }
    for (const [location, value] of Object.entries(data.packages ?? {})) {
      const name = location.split('node_modules/').at(-1)
      if (browserPackages.has(name)) result[`${file}:${location}`] = value
    }
  }
  return JSON.stringify(Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b))))
}
try {
  console.log(snapshot(process.env.BASE_SHA) !== snapshot(process.env.HEAD_SHA))
} catch {
  // Malformed or unavailable dependency metadata needs the browser group too.
  console.log(true)
}
