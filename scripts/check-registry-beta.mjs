import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { isNpmRegistryPropagationError, npmViewItem } from './npm-pack-report.mjs'

const execute = promisify(execFile)
let npmCache

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const version = argument('--version')
const registry = argument('--registry') ?? 'https://registry.npmjs.org'
if (typeof version !== 'string' || !/^0\.1\.0-beta\.\d+$/.test(version)) {
  throw new Error('--version must be an exact 0.1.0 beta prerelease')
}
if (registry !== 'https://registry.npmjs.org') throw new Error('registry must be https://registry.npmjs.org')

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

async function retryRegistryPropagation(label, operation) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isNpmRegistryPropagationError(error) || attempt === 12) throw error
      console.log(`[registry] ${label} is still propagating (attempt ${attempt}/12)`)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
}

async function npmJson(args, cwd) {
  const result = await run('npm', [...args, '--json', `--registry=${registry}`], { cwd })
  return JSON.parse(result.stdout)
}

async function npmViewJson(args, cwd) {
  return npmViewItem(await npmJson(['view', ...args], cwd), args[0])
}

async function verifyInstalledPackage(runner, packageName) {
  const packageRoot = path.join(runner, 'node_modules', packageName)
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.version !== version) throw new Error(`${packageName} installed version mismatch`)
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
    'install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`,
  ], { cwd: project })
  await run('npm', ['run', 'check'], { cwd: project })
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: project })
  if (!dryRun.stdout.includes('[cordisx] Vite entry ready:')
    || !dryRun.stdout.includes('"status": "ready"')
    || !dryRun.stdout.includes('"transport": "vite"')) {
    throw new Error('registry-generated plugin failed cordisx dev --dry-run')
  }
}

function assertViteProjectDryRun(stdout, pluginIds) {
  if (!stdout.includes('[cordisx] Vite entry ready:')
    || !stdout.includes('"status": "ready"')
    || !stdout.includes('"transport": "vite"')
    || pluginIds.some(id => !stdout.includes(`"${id}"`))) {
    throw new Error('registry-generated multi-plugin project failed cordisx dev --dry-run')
  }
}

async function verifyGeneratedWorkspace(project, pluginIds) {
  const manifest = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'))
  if (manifest.license !== 'UNLICENSED' || manifest.devDependencies?.cordisx !== version
    || !Array.isArray(manifest.workspaces)) {
    throw new Error('registry-generated plugin workspace metadata is invalid')
  }
  for (const id of pluginIds) {
    const plugin = JSON.parse(await readFile(path.join(project, 'plugins', id, 'package.json'), 'utf8'))
    if (plugin.devDependencies?.cordisx !== version) throw new Error(`registry-generated ${id} dependency mismatch`)
  }
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', `--registry=${registry}`], { cwd: project })
  await run('npm', ['run', 'check'], { cwd: project })
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
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: cordisxRoot })
  assertViteProjectDryRun(dryRun.stdout, pluginIds)
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-registry-beta-'))
try {
  npmCache = path.join(temporaryRoot, 'npm-cache')
  const runner = path.join(temporaryRoot, 'runner')
  const cordisxHome = path.join(temporaryRoot, 'cordisx-home')
  await mkdir(runner, { recursive: true })
  await writeFile(path.join(runner, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`, 'utf8')
  await retryRegistryPropagation('beta package metadata', async () => {
    for (const packageName of ['cordisx', 'create-cordisx-plugin']) {
      const tags = await npmViewJson([packageName, 'dist-tags'], runner)
      if (tags.latest !== '0.0.0') throw new Error(`${packageName} latest must remain 0.0.0`)
      if (tags.beta !== version) {
        const error = new Error(`${packageName} beta dist-tag is still propagating`)
        error.commandOutput = 'ETARGET'
        throw error
      }
    }
  })
  await retryRegistryPropagation('beta package installation', async () => {
    await rm(path.join(runner, 'node_modules'), { recursive: true, force: true })
    await rm(path.join(runner, 'package-lock.json'), { force: true })
    await run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      'cordisx@beta',
      'create-cordisx-plugin@beta',
      `--registry=${registry}`,
    ], { cwd: runner })
  })
  await verifyInstalledPackage(runner, 'cordisx')
  await verifyInstalledPackage(runner, 'create-cordisx-plugin')

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
    'create', 'cordisx-plugin@beta', createTarget,
  ], { cwd: runner })
  await run('npx', ['--yes', 'create-cordisx-plugin@beta', npxTarget], { cwd: runner })
  await verifyGeneratedProject(createTarget)
  await verifyGeneratedProject(npxTarget)

  await run(creatorBin, [
    '--mode', 'workspace', workspaceTarget, '--plugin', 'alpha', '--plugin', 'beta',
  ], { cwd: runner })
  await verifyGeneratedWorkspace(workspaceTarget, ['alpha', 'beta'])

  for (const project of [embeddedWorkspaceTarget, embeddedIsolatedTarget]) {
    await mkdir(project, { recursive: true })
  }
  await writeFile(path.join(embeddedWorkspaceTarget, 'package.json'), `${JSON.stringify({
    name: 'embedded-workspace-fixture', private: true, workspaces: [],
  }, null, 2)}\n`, 'utf8')
  await writeFile(path.join(embeddedIsolatedTarget, 'package.json'), `${JSON.stringify({
    name: 'embedded-isolated-fixture', private: true,
  }, null, 2)}\n`, 'utf8')
  await run(creatorBin, [
    '--mode', 'embedded', embeddedWorkspaceTarget, '--plugin', 'alpha', '--package-manager', 'npm',
  ], { cwd: runner })
  await run(creatorBin, [
    '--mode', 'embedded', embeddedWorkspaceTarget, '--plugin', 'beta', '--package-manager', 'npm',
  ], { cwd: runner })
  await run(creatorBin, [
    '--mode', 'embedded', embeddedIsolatedTarget, '--plugin', 'solo', '--integration', 'isolated', '--package-manager', 'npm',
  ], { cwd: runner })
  await verifyGeneratedEmbedded(embeddedWorkspaceTarget, ['alpha', 'beta'], true)
  await verifyGeneratedEmbedded(embeddedIsolatedTarget, ['solo'], false)

  for (const packageName of ['cordisx', 'create-cordisx-plugin']) {
    const tags = await npmViewJson([packageName, 'dist-tags'], runner)
    if (tags.beta !== version) throw new Error(`${packageName} beta dist-tag mismatch`)
    if (tags.latest !== '0.0.0') throw new Error(`${packageName} latest must remain 0.0.0`)
  }

  console.log(JSON.stringify({
    status: 'verified',
    source: 'registry',
    version,
    license: 'AGPL-3.0-or-later',
    pluginException: true,
    creatorForms: ['npm create cordisx-plugin@beta', 'npx create-cordisx-plugin@beta'],
    creatorModes: ['single', 'workspace', 'embedded-workspace', 'embedded-isolated'],
    latest: '0.0.0',
  }))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
