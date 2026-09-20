import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseFromTag } from './release-version.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const allowPendingLicense = process.argv.includes('--allow-pending-license')
const expectedVersion = '0.1.0-beta.15'
const expectedProtocolVersion = '0.1.0-beta.7'
const expectedCliProxySource = 'github:cordisx/plugin-cli-proxy-api#12d5daa36dbd5dd565b96d22859afb1d0f3f3e1d'
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
  assert(manifest.publishConfig?.tag === undefined, `${input.name} publish tag must be selected by the release`)
  assert(manifest.publishConfig?.provenance === true, `${input.name} provenance must be enabled`)
}

const [
  root,
  cli,
  creator,
  channelRuntime,
  rootReadme,
  rootReadmeZh,
  cliReadme,
  creatorReadme,
  gettingStarted,
  workflow,
  releaseScript,
  registryScript,
] = await Promise.all([
  json('package.json'),
  json('packages/cli/package.json'),
  json('packages/create-cordisx-plugin/package.json'),
  json('packages/channel-runtime/package.json'),
  readFile(path.join(repositoryRoot, 'README.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'README.zh-CN.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'packages/cli/README.md'), 'utf8'),
  readFile(path.join(repositoryRoot, 'packages/create-cordisx-plugin/README.md'), 'utf8'),
  readFile(path.join(repositoryRoot, '.agents/docs/getting-started.md'), 'utf8'),
  readFile(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8'),
  readFile(path.join(repositoryRoot, 'scripts/release.mjs'), 'utf8'),
  readFile(path.join(repositoryRoot, 'scripts/check-registry-release.mjs'), 'utf8'),
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
assert(root.version === expectedVersion, `root version must be ${expectedVersion}`)
assert(cli.version === creator.version, 'repository release package versions must match')
const expectedRelease = releaseFromTag(`v${expectedVersion}`)
assert(expectedRelease.version === expectedVersion, 'release tag parser must preserve the package version')
assert(expectedRelease.distTag === 'beta', 'current prerelease must derive the beta channel')
assert(
  root.dependencies?.['@cordisx/protocol'] === expectedProtocolVersion,
  `root must consume @cordisx/protocol@${expectedProtocolVersion}`,
)
assert(
  cli.dependencies?.['@cordisx/protocol'] === expectedProtocolVersion,
  `cordisx must consume @cordisx/protocol@${expectedProtocolVersion}`,
)
assert(root.optionalDependencies?.fsevents === '~2.3.3', 'root must preserve Vite fsevents as optional')
assert(cli.optionalDependencies?.fsevents === '~2.3.3', 'cordisx must preserve Vite fsevents as optional')
assert(
  channelRuntime.dependencies?.['@cordisx/protocol'] === expectedProtocolVersion,
  `channel runtime must consume @cordisx/protocol@${expectedProtocolVersion}`,
)
assert(
  root.cordisxSources?.['@cordisx/plugin-cli-proxy-api'] === expectedCliProxySource,
  'root CLIProxy source must pin canonical main',
)
assert(
  cli.cordisxSources?.['@cordisx/plugin-cli-proxy-api'] === expectedCliProxySource,
  'cordisx CLIProxy source must pin canonical main',
)
assert(JSON.stringify(creator.exports) === '{}', 'creator must not expose its executable as an import API')

for (
  const [label, readme] of [
    ['cordisx README', cliReadme],
    ['creator README', creatorReadme],
  ]
) {
  assert(readme.includes('@beta'), `${label} must use the beta channel`)
}
for (
  const [label, readme] of [
    ['root README', rootReadme],
    ['Chinese root README', rootReadmeZh],
  ]
) {
  assert(readme.includes('npx cordisx@beta'), `${label} must document the beta launcher`)
  assert(readme.includes('startup-qa'), `${label} must link startup self-service`)
  assert(readme.includes('.agents/docs/README.md'), `${label} must link the documentation index`)
  assert(readme.includes('cordisx-ai-plugin-demo'), `${label} must show the AI-first plugin demo`)
}
assert(gettingStarted.includes('npx cordisx@beta setup'), 'getting started must document beta setup')
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
assert(workflow.includes("tags:\n      - 'v*'"), 'release workflow must be triggered by repository version tags')
assert(!workflow.includes('workflow_dispatch'), 'release workflow must not create a second manual version interface')
assert(workflow.includes('environment: npm-release'), 'release workflow must use the npm-release environment')
assert(workflow.includes('npm@11.11.0'), 'release workflow must pin an OIDC-capable npm CLI')
assert(workflow.includes('actions/cache/restore@v4'), 'release workflow must restore exact prepared artifacts')
assert(workflow.includes('actions/cache/save@v4'), 'release workflow must save prepared artifacts before publication')
assert(workflow.includes('${{ github.sha }}'), 'release artifact cache must be bound to the exact Git commit')
assert(
  workflow.includes('npm ci --registry=https://registry.npmjs.org'),
  'release install must prepare registry and remaining Git dependencies',
)
assert(!workflow.includes('npm ci --ignore-scripts'), 'release install must not skip Git dependency preparation')
for (const command of ['npm run test:release', 'npm run build', 'npm run check:release', 'npm run check:package']) {
  assert(workflow.includes(command), `release workflow must run ${command}`)
}
assert(!workflow.includes('npm run check\n'), 'release workflow must not expand into the full regression gate')
assert(workflow.includes('scripts/release.mjs --tag'), 'release workflow must publish from the Git tag')
assert(workflow.includes('check-registry-release.mjs --tag'), 'release workflow must verify a clean tagged install')
assert(
  workflow.indexOf('actions/cache/save@v4') < workflow.indexOf('scripts/release.mjs --tag'),
  'prepared release artifacts must be saved before publication can fail',
)
assert(workflow.includes('${GITHUB_REF_NAME}'), 'release workflow must derive the version from the pushed tag')
assert(!workflow.includes(expectedVersion), 'release workflow must not hard-code the current version')
assert(!workflow.includes('release-beta') && !workflow.includes('--scope'), 'release workflow must remain generic')
assert(releaseScript.includes('./release-version.mjs'), 'publisher must derive version and channel from the tag')
assert(releaseScript.includes('`--tag=${distTag}`'), 'publisher must pass the dynamic npm dist-tag')
assert(releaseScript.includes("'--provenance'"), 'publisher must request npm provenance explicitly')
assert(releaseScript.includes("'--ignore-scripts'"), 'publisher must reuse the already validated build outputs')
assert(
  releaseScript.includes('publishReleasePackages'),
  'publisher must submit missing packages before converged registry verification',
)
assert(!releaseScript.includes('--tag=beta'), 'publisher must not hard-code the beta channel')
assert(registryScript.includes('./release-version.mjs'), 'registry verification must derive the selected channel')
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
    readFile(
      path.join(repositoryRoot, 'packages/create-cordisx-plugin/CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'),
      'utf8',
    ),
  ])
  assert(rootLicense === cliLicense && cliLicense === creatorLicense, 'repository and tarball licenses must match')
  assert(
    rootException === cliException && cliException === creatorException,
    'repository and tarball plugin exceptions must match',
  )
  assert(cli.files.includes('LICENSE'), 'cordisx tarball allowlist must include LICENSE')
  assert(creator.files.includes('LICENSE'), 'creator tarball allowlist must include LICENSE')
  assert(
    cli.files.includes('CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'),
    'cordisx tarball must include the plugin exception',
  )
  assert(
    creator.files.includes('CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'),
    'creator tarball must include the plugin exception',
  )
} else {
  for (const relative of ['LICENSE', 'packages/cli/LICENSE', 'packages/create-cordisx-plugin/LICENSE']) {
    await access(path.join(repositoryRoot, relative)).then(
      () => {
        throw new Error(`pending-license mode must not commit ${relative}`)
      },
      error => {
        if (error.code !== 'ENOENT') throw error
      },
    )
  }
}

console.log(`[release] metadata verified for ${expectedVersion}${allowPendingLicense ? ' (license pending)' : ''}`)
