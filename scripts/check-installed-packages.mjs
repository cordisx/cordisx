import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { npmPackItem } from './npm-pack-report.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function run(file, args, options = {}) {
  try {
    return await execute(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(`${file} ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error })
  }
}

function parsePackReport(stdout, packageName) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`npm pack did not return JSON:\n${stdout}`, { cause: error })
  }
  const filename = npmPackItem(report, packageName).filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('npm pack did not report a tarball filename')
  }
  return filename
}

async function packWorkspace(workspace, packDirectory) {
  const packed = await run('npm', [
    'pack',
    `--workspace=${workspace}`,
    '--pack-destination',
    packDirectory,
    '--json',
  ], { cwd: repositoryRoot, env: process.env })
  return path.join(packDirectory, parsePackReport(packed.stdout, workspace))
}

async function expectMissing(target, label) {
  try {
    await access(target)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`${label} must not be created by --dry-run: ${target}`)
}

async function verifyGeneratedProject(project, cordisxTarball, expectedVersion) {
  const packagePath = path.join(project, 'package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'))
  if (manifest.license !== 'UNLICENSED') {
    throw new Error('generated plugin must leave its author an explicit license choice')
  }
  if (manifest.devDependencies?.cordisx !== expectedVersion) {
    throw new Error(`generated CordisX dependency must be ${expectedVersion}`)
  }
  manifest.devDependencies.cordisx = `file:${cordisxTarball}`
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: project,
    env: process.env,
  })
  await run('npm', ['run', 'check'], { cwd: project, env: process.env })
  const dryRun = await run('npm', ['run', 'dev:dry-run'], { cwd: project, env: process.env })
  if (!dryRun.stdout.includes('[cordisx] bundle ready:') || !dryRun.stdout.includes('"status": "ready"')) {
    throw new Error('generated plugin was not accepted by cordisx dev --dry-run')
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-installed-check-'))
try {
  const packDirectory = path.join(temporaryRoot, 'pack')
  const runnerDirectory = path.join(temporaryRoot, 'runner')
  const cordisxHome = path.join(temporaryRoot, 'cordisx-home')
  await mkdir(packDirectory, { recursive: true })
  await mkdir(runnerDirectory, { recursive: true })
  await writeFile(
    path.join(runnerDirectory, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
    'utf8',
  )

  const [cordisxTarball, creatorTarball] = await Promise.all([
    packWorkspace('cordisx', packDirectory),
    packWorkspace('create-cordisx-plugin', packDirectory),
  ])
  await run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    cordisxTarball,
    creatorTarball,
  ], { cwd: runnerDirectory, env: process.env })

  for (const packageName of ['cordisx', 'create-cordisx-plugin']) {
    const packageRoot = path.join(runnerDirectory, 'node_modules', packageName)
    const installedManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (installedManifest.license !== 'AGPL-3.0-or-later') {
      throw new Error(`${packageName} installed license metadata is invalid`)
    }
    await access(path.join(packageRoot, 'LICENSE'))
    await access(path.join(packageRoot, 'CORDISX-INDEPENDENT-PLUGIN-EXCEPTION.md'))
  }

  const binDirectory = path.join(runnerDirectory, 'node_modules', '.bin')
  const executable = name => path.join(
    binDirectory,
    process.platform === 'win32' ? `${name}.cmd` : name,
  )
  const cliEnvironment = { ...process.env, CORDISX_HOME: cordisxHome }
  const help = await run(executable('cordisx'), ['--help'], {
    cwd: runnerDirectory,
    env: cliEnvironment,
  })
  if (!help.stdout.includes('cordisx setup')) throw new Error('installed cordisx --help is incomplete')

  await run(executable('cordisx'), ['setup'], { cwd: runnerDirectory, env: cliEnvironment })
  const configPath = path.join(cordisxHome, 'config.json')
  const initialConfig = JSON.parse(await readFile(configPath, 'utf8'))
  if (!Array.isArray(initialConfig.plugins) || initialConfig.plugins.length !== 0) {
    throw new Error('installed cordisx setup must create plugins: []')
  }

  const config = await run(executable('cordisx'), ['config'], {
    cwd: runnerDirectory,
    env: cliEnvironment,
  })
  if (!config.stdout.includes(configPath)) {
    throw new Error('installed cordisx config did not report its home config')
  }
  const doctor = await run(executable('cordisx'), ['doctor'], {
    cwd: runnerDirectory,
    env: cliEnvironment,
  })
  if (!doctor.stdout.includes('"status"')) throw new Error('installed cordisx doctor did not report a status')

  const profileRoot = path.join(cordisxHome, 'apps', 'codex', 'profiles', 'work')
  await run(executable('cordisx'), [
    'codex',
    'work',
    '--dry-run',
    '--executable',
    process.execPath,
  ], { cwd: runnerDirectory, env: cliEnvironment })
  const persistedConfig = JSON.parse(await readFile(configPath, 'utf8'))
  if (persistedConfig.apps?.codex?.profiles?.work?.dataMode !== 'isolated') {
    throw new Error('installed cordisx dry-run must persist a new work profile as isolated')
  }
  await expectMissing(profileRoot, 'named profile data directory')

  const createTarget = path.join(temporaryRoot, 'from-npm-create')
  const npxTarget = path.join(temporaryRoot, 'from-npx')
  await run('npm', ['create', 'cordisx-plugin', createTarget], {
    cwd: runnerDirectory,
    env: process.env,
  })
  await run('npm', ['exec', '--', 'create-cordisx-plugin', npxTarget], {
    cwd: runnerDirectory,
    env: process.env,
  })
  const creatorManifest = JSON.parse(await readFile(
    path.join(runnerDirectory, 'node_modules/create-cordisx-plugin/package.json'),
    'utf8',
  ))
  await verifyGeneratedProject(createTarget, cordisxTarball, creatorManifest.version)
  await verifyGeneratedProject(npxTarget, cordisxTarball, creatorManifest.version)

  console.log('[cordisx] installed tarballs verified: licenses, CLI, both creator forms, generated checks, dev dry-run')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
