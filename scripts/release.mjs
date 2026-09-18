import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { npmMaintainerNames, npmPackItem, npmViewItem } from './npm-pack-report.mjs'
import { releasePackageDefinitions } from './release-packages.mjs'
import { publishReleasePackages } from './release-publication.mjs'
import { releaseFromTag } from './release-version.mjs'
import { retryRegistryPropagation } from './registry-release-propagation.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const release = releaseFromTag(argument('--tag'))
const { tag, version, distTag } = release
const registry = argument('--registry') ?? 'https://registry.npmjs.org'
if (registry !== 'https://registry.npmjs.org') throw new Error('release registry must be https://registry.npmjs.org')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('publication is restricted to GitHub Actions')
if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== 'cordisx/cordisx') {
  throw new Error('publication is restricted to cordisx/cordisx')
}
if (process.env.GITHUB_REF !== `refs/tags/${tag}`) throw new Error('publication requires the matching Git tag')
if (!process.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/release.yml@')) {
  throw new Error('publication is restricted to release.yml')
}
if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  throw new Error('GitHub OIDC environment is unavailable')
}
if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) {
  throw new Error('long-lived npm tokens are forbidden in the release job')
}

async function run(file, args, options = {}) {
  try {
    return await execute(file, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    const wrapped = new Error(`${file} ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error })
    wrapped.commandOutput = `${stdout}${stderr}`
    throw wrapped
  }
}

async function runNpm(args, options = {}) {
  try {
    return await run('npm', [...args, `--registry=${registry}`], {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, npm_config_registry: registry },
    })
  } catch (error) {
    error.npmOutput = error.commandOutput
    throw error
  }
}

async function npmJson(args, options) {
  const result = await runNpm([...args, '--json'], options)
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`npm ${args.join(' ')} did not return JSON`, { cause: error })
  }
}

async function npmViewJson(args, options) {
  return npmViewItem(await npmJson(['view', ...args], options), args[0])
}

async function readManifest(pkg) {
  return JSON.parse(await readFile(path.join(repositoryRoot, pkg.directory, 'package.json'), 'utf8'))
}

async function viewVersion(name, requestedVersion) {
  try {
    return await npmViewJson([`${name}@${requestedVersion}`])
  } catch (error) {
    if (typeof error.npmOutput === 'string' && /E404|404 Not Found/.test(error.npmOutput)) return undefined
    throw error
  }
}

async function assertRegistryPackage(pkg) {
  const metadata = await npmViewJson([pkg.name])
  if (!npmMaintainerNames(metadata.maintainers).includes('yijie4188')) {
    throw new Error(`${pkg.name} registry owner yijie4188 is missing`)
  }
  return metadata
}

async function pack(pkg, destination) {
  const report = await npmJson([
    'pack',
    `--workspace=${pkg.workspace}`,
    '--ignore-scripts',
    '--pack-destination',
    destination,
  ])
  const item = npmPackItem(report, pkg.name)
  if (item?.version !== version || typeof item?.integrity !== 'string') {
    throw new Error(`${pkg.name} local pack report is incomplete`)
  }
  return item
}

const expectedGitHead = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim()
const tagGitHead = (await run('git', ['rev-list', '-n', '1', tag])).stdout.trim()
if (tagGitHead !== expectedGitHead) throw new Error('release tag must resolve to the checked-out commit')
await run('git', ['merge-base', '--is-ancestor', expectedGitHead, 'refs/remotes/origin/main'])

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-release-'))
try {
  const manifests = new Map()
  const packs = new Map()
  for (const pkg of releasePackageDefinitions) {
    const manifest = await readManifest(pkg)
    if (manifest.version !== version) throw new Error(`${pkg.name} manifest version does not match ${version}`)
    if (manifest.license !== 'AGPL-3.0-or-later') {
      throw new Error(`${pkg.name} license must be AGPL-3.0-or-later`)
    }
    manifests.set(pkg.name, manifest)
    await assertRegistryPackage(pkg)
  }
  const manifestVersions = new Set([...manifests.values()].map(manifest => manifest.version))
  if (manifestVersions.size !== 1) throw new Error('repository release package versions must match')

  for (const pkg of releasePackageDefinitions) packs.set(pkg.name, await pack(pkg, temporaryRoot))

  const published = await publishReleasePackages({
    packages: releasePackageDefinitions,
    manifests,
    packs,
    version,
    distTag,
    gitHead: expectedGitHead,
    viewVersion,
    viewTags: name => npmViewJson([name, 'dist-tags']),
    assertRegistryPackage,
    publish: pkg =>
      runNpm([
        'publish',
        `--workspace=${pkg.workspace}`,
        '--ignore-scripts',
        `--tag=${distTag}`,
        '--access=public',
        '--provenance',
      ]),
    retry: (label, operation) => retryRegistryPropagation(label, operation),
  })

  console.log(JSON.stringify({
    status: 'published',
    tag,
    version,
    distTag,
    gitHead: expectedGitHead,
    packages: published,
  }))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
