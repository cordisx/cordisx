const { EVENT, BROWSER, FULL, NODE_ALL } = process.env
const projects = ['core', 'renderer', 'integration']
if (EVENT === 'push' || BROWSER === 'true') projects.push('browser')

const matrix = { project: projects }
// Affected PRs use Vitest's dynamic test selection and remain unsharded.
// Full suites have a stable file set that Vitest can partition across runners.
if (EVENT === 'push' || FULL === 'true' || NODE_ALL === 'true') {
  matrix.exclude = [{ project: 'integration' }]
  matrix.include = [
    { project: 'integration', shard: '1/2', shard_id: '1' },
    { project: 'integration', shard: '2/2', shard_id: '2' },
  ]
}

console.log(`matrix=${JSON.stringify(matrix)}`)
