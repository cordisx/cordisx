import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowPendingLicense = process.argv.includes('--allow-pending-license')
const expectedVersion = '0.1.0-beta.1'
const expectedRepository = 'git+https://github.com/cordisx/cordisx.git'

async function json(relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function validatePackage(manifest, input) {
  assert(manifest.name === input.name, `${input.name} package name is invalid`)
  assert(manifest.version === expectedVersion, `${input.name} version must be ${expectedVersion}`)
  assert(manifest.private === undefined, `${input.name} must be publishable`)
  assert(manifest.repository?.type === 'git', `${input.name} repository type must be git`)
  assert(manifest.repository?.url === expectedRepository, `${input.name} repository URL is invalid`)
  assert(manifest.repository?.directory === input.directory, `${input.name} repository directory is invalid`)
  assert(manifest.homepage === 'https://cordisx.github.io/', `${input.name} homepage is invalid`)
  assert(manifest.bugs?.url === 'https://github.com/cordisx/cordisx/issues', `${input.name} bugs URL is invalid`)
  assert(manifest.engines?.node === '>=22.19', `${input.name} Node engine is invalid`)
  assert(manifest.bin?.[input.bin] === input.binPath, `${input.name} bin metadata is invalid`)
  assert(Array.isArray(manifest.files), `${input.name} files must be an allowlist`)
  for (const required of input.files) {
    assert(manifest.files.includes(required), `${input.name} files is missing ${required}`)
  }
  assert(manifest.publishConfig?.access === 'public', `${input.name} publish access must be public`)
  assert(manifest.publishConfig?.tag === 'beta', `${input.name} publish tag must be beta`)
  assert(manifest.publishConfig?.provenance === true, `${input.name} provenance must be enabled`)
}

const [
  cli,
  creator,
  rootReadme,
  rootReadmeZh,
  cliReadme,
  creatorReadme,
  gettingStarted,
  workflow,
] = await Promise.all([
  json('packages/cli/package.json'),
  json('packages/create-cordisx-plugin/package.json'),
  readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'README.zh-CN.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'packages/create-cordisx-plugin/README.md'), 'utf8'),
  readFile(path.join(repositoryRoot, '.agents/docs/getting-started.md'), 'utf8'),
  readFile(path.join(repositoryRoot, '.github/workflows/release-beta.yml'), 'utf8'),
])

validatePackage(cli, {
  name: 'cordisx',
  directory: 'packages/cli',
  bin: 'cordisx',
  binPath: 'dist/src/cli.js',
  files: ['dist', 'README.md'],
})
validatePackage(creator, {
  name: 'create-cordisx-plugin',
  directory: 'packages/create-cordisx-plugin',
  bin: 'create-cordisx-plugin',
  binPath: 'dist/cli.js',
  files: ['dist', 'template', 'README.md'],
})
assert(JSON.stringify(creator.exports) === '{}', 'creator must not expose its executable as an import API')

for (const [label, readme] of [
  ['cordisx README', cliReadme],
  ['creator README', creatorReadme],
]) {
  assert(readme.includes('@beta'), `${label} must use the beta channel`)
}
for (const [label, readme] of [
  ['root README', rootReadme],
  ['Chinese root README', rootReadmeZh],
]) {
  assert(readme.includes('npx cordisx@beta setup'), `${label} must document beta setup`)
  assert(readme.includes('npm create cordisx-plugin@beta'), `${label} must document beta plugin creation`)
  assert(readme.includes('plugins: []'), `${label} must document the empty plugin default`)
  assert(readme.includes('--data shared'), `${label} must document shared profiles`)
  assert(readme.includes('--data host-isolated'), `${label} must document host-isolated profiles`)
  assert(readme.includes('getting-started.md#npm-beta-installation'), `${label} must link the beta guide`)
  assert(readme.includes('distribution-and-cli.md'), `${label} must link the CLI and distribution guide`)
}
assert(gettingStarted.includes('plugins: []'), 'getting started must document the empty plugin default')
assert(gettingStarted.includes('--data shared'), 'getting started must document shared profiles')
assert(gettingStarted.includes('--data host-isolated'), 'getting started must document host-isolated profiles')
assert(gettingStarted.includes('npm create cordisx-plugin@beta'), 'getting started must document plugin creation')
assert(gettingStarted.includes('npm run dev:dry-run'), 'getting started must document plugin dry-run')
assert(rootReadme.includes('AGPL-3.0-or-later'), 'root README must explain the core license')
assert(rootReadme.includes('Independent Plugin Exception'), 'root README must explain the plugin exception')
assert(cliReadme.includes('AGPL-3.0-or-later'), 'cordisx package README must explain the core license')
assert(creatorReadme.includes('Independent Plugin Exception'), 'creator README must explain the template exception')

assert(workflow.includes('id-token: write'), 'release workflow must grant OIDC id-token permission')
assert(workflow.includes('environment: npm-beta'), 'release workflow must use the npm-beta environment')
assert(workflow.includes('npm@12.0.2'), 'release workflow must pin an OIDC-capable npm CLI')
assert(workflow.includes('check-registry-beta.mjs'), 'release workflow must verify clean registry installation')
assert(!/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/.test(workflow), 'release workflow must not reference npm tokens')

if (!allowPendingLicense) {
  assert(cli.license === 'AGPL-3.0-or-later', 'cordisx license must use the valid SPDX identifier AGPL-3.0-or-later')
  assert(cli.license === creator.license, 'public package licenses must match')
  const [rootLicense, cliLicense, creatorLicense, rootException, cliException, creatorException] = await Promise.all([
    readFile(path.join(repositoryRoot, 'LICENSE'), 'utf8'),
    readFile(path.join(repositoryRoot, 'packages/cli/LICENSE'), 'utf8'),
    readFile(path.join(repositoryRoot, 'packages/create-cordisx-plugin/LICENSE'), 'utf8'),
    readFile(path.join(repositoryRoot, 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'), 'utf8'),
    readFile(path.join(repositoryRoot, 'packages/cli/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'), 'utf8'),
    readFile(path.join(repositoryRoot, 'packages/create-cordisx-plugin/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'), 'utf8'),
  ])
  assert(rootLicense === cliLicense && cliLicense === creatorLicense, 'repository and tarball licenses must match')
  assert(rootException === cliException && cliException === creatorException, 'repository and tarball plugin exceptions must match')
  assert(cli.files.includes('LICENSE'), 'cordisx tarball allowlist must include LICENSE')
  assert(creator.files.includes('LICENSE'), 'creator tarball allowlist must include LICENSE')
  assert(cli.files.includes('CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'), 'cordisx tarball must include the plugin exception')
  assert(creator.files.includes('CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'), 'creator tarball must include the plugin exception')
} else {
  for (const relative of ['LICENSE', 'packages/cli/LICENSE', 'packages/create-cordisx-plugin/LICENSE']) {
    await access(path.join(repositoryRoot, relative)).then(
      () => { throw new Error(`pending-license mode must not commit ${relative}`) },
      error => { if (error.code !== 'ENOENT') throw error },
    )
  }
}

console.log(`[release] metadata verified for ${expectedVersion}${allowPendingLicense ? ' (license pending)' : ''}`)
