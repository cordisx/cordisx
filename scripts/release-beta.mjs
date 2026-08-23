import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { npmPackItem, npmViewItem } from './npm-pack-report.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packages = [
  { name: 'cordisx', workspace: 'cordisx', directory: 'packages/cli' },
  { name: 'create-cordisx-plugin', workspace: 'create-cordisx-plugin', directory: 'packages/create-cordisx-plugin' },
]

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const version = argument('--version')
const registry = argument('--registry') ?? 'https://registry.npmjs.org'
if (typeof version !== 'string' || !/^0\.1\.0-beta\.\d+$/.test(version)) {
  throw new Error('--version must be an immutable 0.1.0 beta prerelease')
}
if (registry !== 'https://registry.npmjs.org') throw new Error('release registry must be https://registry.npmjs.org')
if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('beta publication is restricted to GitHub Actions')
if (process.env.GITHUB_REPOSITORY?.toLowerCase() !== 'cordisx/cordisx') {
  throw new Error('beta publication is restricted to cordisx/cordisx')
}
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('beta publication is restricted to main')
if (!process.env.GITHUB_WORKFLOW_REF?.includes('/.github/workflows/release-beta.yml@')) {
  throw new Error('beta publication is restricted to release-beta.yml')
}
if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
  throw new Error('GitHub OIDC environment is unavailable')
}
if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) {
  throw new Error('long-lived npm tokens are forbidden in the beta release job')
}

async function runNpm(args, options = {}) {
  try {
    return await execute('npm', [...args, `--registry=${registry}`], {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, npm_config_registry: registry },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    const wrapped = new Error(`npm ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error })
    wrapped.npmOutput = `${stdout}${stderr}`
    throw wrapped
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

function maintainerNames(value) {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return entries.map(entry => typeof entry === 'string' ? entry : entry?.name).filter(Boolean)
}

async function assertRegistryPackage(pkg) {
  const metadata = await npmViewJson([pkg.name])
  if (!maintainerNames(metadata.maintainers).includes('yijie4188')) {
    throw new Error(`${pkg.name} registry owner yijie4188 is missing`)
  }
  if (metadata['dist-tags']?.latest !== '0.0.0') {
    throw new Error(`${pkg.name} latest must remain 0.0.0`)
  }
  return metadata
}

async function pack(pkg, destination) {
  const report = await npmJson([
    'pack',
    `--workspace=${pkg.workspace}`,
    '--pack-destination',
    destination,
  ])
  const item = npmPackItem(report, pkg.name)
  if (item?.version !== version || typeof item?.integrity !== 'string') {
    throw new Error(`${pkg.name} local pack report is incomplete`)
  }
  return item
}

function sameRepository(actual, expected) {
  const url = typeof actual === 'string' ? actual : actual?.url
  return url === expected.repository.url
}

function assertPublishedMetadata(pkg, manifest, packed, metadata) {
  if (metadata.version !== version) throw new Error(`${pkg.name} registry version mismatch`)
  if (metadata.dist?.integrity !== packed.integrity) throw new Error(`${pkg.name} registry tarball integrity mismatch`)
  if (metadata.license !== manifest.license) throw new Error(`${pkg.name} registry license mismatch`)
  if (!sameRepository(metadata.repository, manifest)) throw new Error(`${pkg.name} registry repository mismatch`)
  if (JSON.stringify(metadata.bin) !== JSON.stringify(manifest.bin)) throw new Error(`${pkg.name} registry bin mismatch`)
  if (JSON.stringify(metadata.engines) !== JSON.stringify(manifest.engines)) throw new Error(`${pkg.name} registry engines mismatch`)
}

async function readBack(pkg, manifest, packed) {
  let metadata
  for (let attempt = 0; attempt < 10; attempt += 1) {
    metadata = await viewVersion(pkg.name, version)
    if (metadata?.dist?.integrity === packed.integrity) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (metadata === undefined) throw new Error(`${pkg.name}@${version} is missing after publish`)
  assertPublishedMetadata(pkg, manifest, packed, metadata)
  const registryPackage = await assertRegistryPackage(pkg)
  if (registryPackage['dist-tags']?.beta !== version) {
    throw new Error(`${pkg.name} beta dist-tag does not point to ${version}`)
  }
  return metadata
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-release-'))
try {
  const manifests = new Map()
  const packs = new Map()
  for (const pkg of packages) {
    const manifest = await readManifest(pkg)
    if (manifest.version !== version) throw new Error(`${pkg.name} manifest version does not match ${version}`)
    if (manifest.license !== 'AGPL-3.0-or-later') {
      throw new Error(`${pkg.name} license must be AGPL-3.0-or-later`)
    }
    manifests.set(pkg.name, manifest)
    await assertRegistryPackage(pkg)
  }
  for (const pkg of packages) packs.set(pkg.name, await pack(pkg, temporaryRoot))

  for (const pkg of packages) {
    const manifest = manifests.get(pkg.name)
    const packed = packs.get(pkg.name)
    const existing = await viewVersion(pkg.name, version)
    if (existing !== undefined) {
      assertPublishedMetadata(pkg, manifest, packed, existing)
      const tags = await npmViewJson([pkg.name, 'dist-tags'])
      if (tags.beta !== version) {
        throw new Error(`${pkg.name}@${version} already exists but beta does not point to it`)
      }
      console.log(`[release] ${pkg.name}@${version} already matches; skipping publish`)
    } else {
      await runNpm([
        'publish',
        `--workspace=${pkg.workspace}`,
        '--tag=beta',
        '--access=public',
      ])
      console.log(`[release] published ${pkg.name}@${version}`)
    }
    await readBack(pkg, manifest, packed)
  }

  console.log(JSON.stringify({
    status: 'published',
    version,
    distTag: 'beta',
    latest: '0.0.0',
    packages: packages.map(pkg => pkg.name),
  }))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
