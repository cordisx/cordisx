import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { enableInstalledChannel, verifyInstalledChannel } from './check-installed-channel.mjs'
import { npmViewItem } from './npm-pack-report.mjs'
import { releasePackageDefinitions, releasePackageNames } from './release-packages.mjs'
import { assertImmutablePublishedMetadata, hasProvenance } from './release-publication.mjs'
import { releaseFromTag } from './release-version.mjs'
import {
  markRegistryPropagationError,
  registryAttemptCache,
  retryRegistryPropagation,
} from './registry-release-propagation.mjs'
import {
  advanceReleaseRecovery,
  assertReleaseRecoveryPackage,
  loadReleaseRecovery,
  releaseRecoveryStages,
} from './release-recovery-state.mjs'

const execute = promisify(execFile)
let npmCache

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const packages = releasePackageNames()
const release = releaseFromTag(argument('--tag'))
const { version, distTag } = release
const registry = argument('--registry') ?? 'https://registry.npmjs.org'
const releaseManifestPath = argument('--release-manifest')
  ?? path.join(process.cwd(), '.release-cache', 'release-manifest.json')
const releaseStatePath = argument('--release-state')
  ?? path.join(process.cwd(), '.release-cache', 'release-state.json')
const releaseArtifactRoot = argument('--release-artifact-root')
  ?? path.join(process.cwd(), '.release-cache', 'release-packages')
if (registry !== 'https://registry.npmjs.org') throw new Error('registry must be https://registry.npmjs.org')

const gitHead = (await execute('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim()
const loaded = await loadReleaseRecovery({
  manifestFile: releaseManifestPath,
  stateFile: releaseStatePath,
  artifactRoot: releaseArtifactRoot,
  commitSha: gitHead,
  tag: release.tag,
  version,
  registry,
  distTag,
  packages,
})
const releaseManifest = loaded.manifest
let releaseState = loaded.state
const remainingStages = releaseRecoveryStages(loaded.recovery.nextPhase)
const packageManifests = new Map(
  await Promise.all(releasePackageDefinitions.map(async pkg => [
    pkg.name,
    JSON.parse(await readFile(path.join(process.cwd(), pkg.directory, 'package.json'), 'utf8')),
  ])),
)
if (remainingStages.length === 0) {
  console.log(JSON.stringify({
    status: 'verified',
    source: 'release-recovery',
    tag: release.tag,
    version,
    recovery: {
      checkpoint: releaseState.recovery.checkpoint,
      nextPhase: releaseState.recovery.nextPhase,
      manifestPath: releaseManifestPath,
      statePath: releaseStatePath,
    },
  }))
  process.exit(0)
}
if (remainingStages.includes('PUBLISHED')) {
  throw new Error('registry verification cannot resume before publication completes')
}

async function run(file, args, options = {}) {
  try {
    return await execute(file, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        npm_config_cache: npmCache,
        npm_config_prefer_online: 'true',
        npm_config_registry: registry,
      },
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

async function npmJson(args, cwd) {
  const result = await run('npm', [...args, '--json', `--registry=${registry}`], { cwd })
  return JSON.parse(result.stdout)
}

async function npmViewJson(args, cwd) {
  return npmViewItem(await npmJson(['view', ...args], cwd), args[0])
}

async function verifyGeneratedViteGraph(graphRoot, label) {
  const artifact = JSON.parse(await readFile(path.join(graphRoot, 'artifact.json'), 'utf8'))
  const entry = artifact.files?.find(file => file.path === artifact.entry)
  const hasLazyModule = artifact.files?.some(file => file.kind === 'module' && file.dynamicImports?.length > 0)
  if (
    artifact.contract !== 'cordisx.plugin-generation-artifact/v1'
    || artifact.entry !== './module.js' || entry?.kind !== 'module'
    || hasLazyModule !== true
  ) {
    throw new Error(`${label} did not emit the expected lazy Vite ESM entry`)
  }
  const chunks = await readdir(path.join(graphRoot, 'chunks'))
  if (!chunks.some(file => file.endsWith('.js'))) throw new Error(`${label} did not emit a lazy JavaScript chunk`)
}

async function verifyInstalledPackage(runner, packageName) {
  const packageRoot = path.join(runner, 'node_modules', packageName)
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.version !== version) {
    const error = new Error(
      `${packageName} installed version mismatch: expected ${version}, received ${manifest.version}`,
    )
    error.code = 'VERSION_MISMATCH'
    throw error
  }
  if (manifest.license !== 'AGPL-3.0-or-later') throw new Error(`${packageName} installed license mismatch`)
  await access(path.join(packageRoot, 'README.md'))
  await access(path.join(packageRoot, 'LICENSE'))
  await access(path.join(packageRoot, 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'))
}

async function verifyGeneratedProject(project) {
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'))
  if (manifest.license !== 'UNLICENSED') throw new Error('generated plugin license choice is not explicit')
  if (manifest.devDependencies?.cordisx !== version) throw new Error('generated plugin CordisX version mismatch')
  await run('npm', [
    'install',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    `--registry=${registry}`,
  ], { cwd: project })
  await run('npm', ['run', 'check'], { cwd: project })
  await verifyGeneratedViteGraph(path.join(project, 'dist', 'runtime'), 'registry-generated standalone plugin')
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: project })
  if (
    !dryRun.stdout.includes('[cordisx] Vite entry ready:')
    || !dryRun.stdout.includes('"status": "ready"')
    || !dryRun.stdout.includes('"transport": "vite"')
  ) {
    throw new Error('registry-generated plugin failed cordisx dev --dry-run')
  }
}

function assertViteProjectDryRun(stdout, pluginIds) {
  if (
    !stdout.includes('[cordisx] Vite entry ready:')
    || !stdout.includes('"status": "ready"')
    || !stdout.includes('"transport": "vite"')
    || pluginIds.some(id => !stdout.includes(`"${id}"`))
  ) {
    throw new Error('registry-generated multi-plugin project failed cordisx dev --dry-run')
  }
}

async function verifyGeneratedWorkspace(project, pluginIds) {
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'))
  if (
    manifest.license !== 'UNLICENSED' || manifest.devDependencies?.cordisx !== version
    || !Array.isArray(manifest.workspaces)
  ) {
    throw new Error('registry-generated plugin workspace metadata is invalid')
  }
  for (const id of pluginIds) {
    const plugin = JSON.parse(await readFile(path.join(project, 'plugins', id, 'package.json'), 'utf8'))
    if (plugin.devDependencies?.cordisx !== version) throw new Error(`registry-generated ${id} dependency mismatch`)
  }
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`], {
    cwd: project,
  })
  await run('npm', ['run', 'check'], { cwd: project })
  for (const id of pluginIds) {
    await verifyGeneratedViteGraph(
      path.join(project, 'plugins', id, 'dist', 'runtime'),
      `registry-generated workspace plugin ${id}`,
    )
  }
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: project })
  assertViteProjectDryRun(dryRun.stdout, pluginIds)
}

async function verifyGeneratedEmbedded(project, pluginIds, integrated) {
  const cordisxRoot = path.join(project, '.cordisx')
  const manifest = JSON.parse(await readFile(path.join(cordisxRoot, 'package.json'), 'utf8'))
  if (manifest.license !== 'UNLICENSED' || manifest.devDependencies?.cordisx !== version) {
    throw new Error('registry-generated embedded package metadata is invalid')
  }
  const rootManifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'))
  if (integrated && !rootManifest.workspaces?.includes('.cordisx')) {
    throw new Error('registry-generated embedded package did not join the npm workspace')
  }
  if (!integrated && rootManifest.workspaces !== undefined) {
    throw new Error('registry-generated isolated fixture unexpectedly became a workspace')
  }
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`], {
    cwd: integrated ? project : cordisxRoot,
  })
  await run('npm', ['run', 'check'], { cwd: cordisxRoot })
  for (const id of pluginIds) {
    await verifyGeneratedViteGraph(
      path.join(cordisxRoot, 'dist', 'runtime', id),
      `registry-generated embedded plugin ${id}`,
    )
  }
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: cordisxRoot })
  assertViteProjectDryRun(dryRun.stdout, pluginIds)
}

function assertReleaseTag(packageName, tags) {
  if (tags[distTag] !== version) {
    throw new Error(`${packageName} ${distTag} dist-tag does not point to ${version}`)
  }
  if (distTag !== 'latest' && tags.latest === version) {
    throw new Error(`${packageName} prerelease must not move latest`)
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-registry-release-'))
try {
  const runner = path.join(temporaryRoot, 'runner')
  const cordisxHome = path.join(temporaryRoot, 'cordisx-home')
  await mkdir(runner, { recursive: true })
  await writeFile(path.join(runner, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`, 'utf8')
  let visibilityAttempt = 0
  await retryRegistryPropagation('release package metadata', async attempt => {
    visibilityAttempt = attempt
    npmCache = registryAttemptCache(temporaryRoot, 'metadata', attempt)
    for (const packageName of packages) {
      const metadata = await npmViewJson([`${packageName}@${version}`], runner)
      assertReleaseRecoveryPackage(metadata, packageName, releaseManifest)
      assertImmutablePublishedMetadata({
        pkg: { name: packageName },
        manifest: packageManifests.get(packageName),
        packed: releaseManifest.packages.find(pkg => pkg.name === packageName).tarball,
        metadata,
        version,
        gitHead,
      })
      if (!hasProvenance(metadata)) {
        throw markRegistryPropagationError(new Error(`${packageName}@${version} provenance is not visible yet`))
      }
    }
  })
  if (remainingStages.includes('VISIBLE')) {
    releaseState = await advanceReleaseRecovery(
      releaseStatePath,
      releaseState,
      releaseManifest,
      'VISIBLE',
      {
        packages,
        registryReadbackAttempt: visibilityAttempt,
        immutableMetadata: true,
        provenance: true,
        workflowRunId: process.env.GITHUB_RUN_ID,
        workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
      { commitSha: gitHead },
    )
  }
  if (remainingStages.includes('VERIFIED')) {
    let installationAttempt = 0
    await retryRegistryPropagation('release package installation', async attempt => {
      installationAttempt = attempt
      npmCache = registryAttemptCache(temporaryRoot, 'install', attempt)
      await rm(path.join(runner, 'node_modules'), { recursive: true, force: true })
      await rm(path.join(runner, 'package-lock.json'), { force: true })
      await run('npm', [
        'install',
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        ...packages.map(name => `${name}@${distTag}`),
        `--registry=${registry}`,
      ], { cwd: runner })
      for (const packageName of packages) {
        try {
          await verifyInstalledPackage(runner, packageName)
        } catch (error) {
          if (error?.code === 'VERSION_MISMATCH') throw markRegistryPropagationError(error)
          throw error
        }
      }
    })

    const bin = path.join(
      runner,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'cordisx.cmd' : 'cordisx',
    )
    const cliEnvironment = { CORDISX_HOME: cordisxHome }
    const help = await run(bin, ['--help'], { cwd: runner, env: cliEnvironment })
    if (!help.stdout.includes('cordisx setup')) throw new Error('registry cordisx --help is incomplete')
    await run(bin, ['setup'], { cwd: runner, env: cliEnvironment })
    const homeConfig = JSON.parse(await readFile(path.join(cordisxHome, 'config.json'), 'utf8'))
    if (!Array.isArray(homeConfig.plugins) || homeConfig.plugins.length !== 0) {
      throw new Error('registry cordisx setup must create plugins: []')
    }
    const installedCordisXRoot = path.join(runner, 'node_modules', 'cordisx')
    const channelConfigPath = path.join(runner, 'channel.config.json')
    enableInstalledChannel(homeConfig)
    await writeFile(channelConfigPath, `${JSON.stringify(homeConfig, null, 2)}\n`, 'utf8')
    const { loadConfig } = await import(
      pathToFileURL(path.join(installedCordisXRoot, 'dist/src/launcher/config.js')).href
    )
    await verifyInstalledChannel({
      cordisxManifest: JSON.parse(await readFile(path.join(installedCordisXRoot, 'package.json'), 'utf8')),
      loadConfig,
      configPath: channelConfigPath,
    })
    await run(bin, ['codex', 'work', '--dry-run', '--executable', process.execPath], {
      cwd: runner,
      env: cliEnvironment,
    })

    const createTarget = path.join(temporaryRoot, 'from-npm-create')
    const npxTarget = path.join(temporaryRoot, 'from-npx')
    const workspaceTarget = path.join(temporaryRoot, 'plugin-workspace')
    const embeddedWorkspaceTarget = path.join(temporaryRoot, 'embedded-workspace')
    const embeddedIsolatedTarget = path.join(temporaryRoot, 'embedded-isolated')
    const creatorBin = path.join(
      runner,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'create-cordisx-plugin.cmd' : 'create-cordisx-plugin',
    )
    await run('npm', [
      'create',
      `cordisx-plugin@${distTag}`,
      createTarget,
    ], { cwd: runner })
    await run('npx', ['--yes', `create-cordisx-plugin@${distTag}`, npxTarget], { cwd: runner })
    await verifyGeneratedProject(createTarget)
    await verifyGeneratedProject(npxTarget)

    await run(creatorBin, [
      '--mode',
      'workspace',
      workspaceTarget,
      '--plugin',
      'alpha',
      '--plugin',
      'beta',
    ], { cwd: runner })
    await verifyGeneratedWorkspace(workspaceTarget, ['alpha', 'beta'])

    for (const project of [embeddedWorkspaceTarget, embeddedIsolatedTarget]) {
      await mkdir(project, { recursive: true })
    }
    await writeFile(
      path.join(embeddedWorkspaceTarget, 'package.json'),
      `${
        JSON.stringify(
          {
            name: 'embedded-workspace-fixture',
            private: true,
            workspaces: [],
          },
          null,
          2,
        )
      }\n`,
      'utf8',
    )
    await writeFile(
      path.join(embeddedIsolatedTarget, 'package.json'),
      `${
        JSON.stringify(
          {
            name: 'embedded-isolated-fixture',
            private: true,
          },
          null,
          2,
        )
      }\n`,
      'utf8',
    )
    await run(creatorBin, [
      '--mode',
      'embedded',
      embeddedWorkspaceTarget,
      '--plugin',
      'alpha',
      '--package-manager',
      'npm',
    ], { cwd: runner })
    await run(creatorBin, [
      '--mode',
      'embedded',
      embeddedWorkspaceTarget,
      '--plugin',
      'beta',
      '--package-manager',
      'npm',
    ], { cwd: runner })
    await run(creatorBin, [
      '--mode',
      'embedded',
      embeddedIsolatedTarget,
      '--plugin',
      'solo',
      '--integration',
      'isolated',
      '--package-manager',
      'npm',
    ], { cwd: runner })
    await verifyGeneratedEmbedded(embeddedWorkspaceTarget, ['alpha', 'beta'], true)
    await verifyGeneratedEmbedded(embeddedIsolatedTarget, ['solo'], false)

    releaseState = await advanceReleaseRecovery(
      releaseStatePath,
      releaseState,
      releaseManifest,
      'VERIFIED',
      {
        packages,
        cleanInstall: true,
        runtimeChecks: true,
        registryInstallationAttempt: installationAttempt,
        creatorModes: ['single', 'workspace', 'embedded-workspace', 'embedded-isolated'],
        workflowRunId: process.env.GITHUB_RUN_ID,
        workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
      { commitSha: gitHead },
    )
  }

  if (remainingStages.includes('DISTRIBUTED')) {
    await retryRegistryPropagation('release package dist-tags', async attempt => {
      npmCache = registryAttemptCache(temporaryRoot, 'dist-tags', attempt)
      for (const packageName of packages) {
        const tags = await npmViewJson([packageName, 'dist-tags'], runner)
        try {
          assertReleaseTag(packageName, tags)
        } catch (error) {
          error.commandOutput = 'ETARGET'
          throw error
        }
      }
    })
    releaseState = await advanceReleaseRecovery(
      releaseStatePath,
      releaseState,
      releaseManifest,
      'DISTRIBUTED',
      {
        packages,
        distTag,
        version,
        workflowRunId: process.env.GITHUB_RUN_ID,
        workflowRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      },
      { commitSha: gitHead },
    )
  }

  console.log(JSON.stringify({
    status: 'verified',
    source: 'registry',
    channelEntry: 'verified',
    tag: release.tag,
    version,
    distTag,
    license: 'AGPL-3.0-or-later',
    pluginException: true,
    packages,
    recovery: {
      checkpoint: releaseState.recovery.checkpoint,
      nextPhase: releaseState.recovery.nextPhase,
      manifestPath: releaseManifestPath,
      statePath: releaseStatePath,
    },
    creatorForms: [`npm create cordisx-plugin@${distTag}`, `npx create-cordisx-plugin@${distTag}`],
    creatorModes: ['single', 'workspace', 'embedded-workspace', 'embedded-isolated'],
  }))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
