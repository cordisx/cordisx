import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

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
      env: { ...process.env, ...options.env, npm_config_registry: registry },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(`${file} ${args.join(' ')} failed\n${stdout}${stderr}`, { cause: error })
  }
}

async function npmJson(args, cwd) {
  const result = await run('npm', [...args, '--json', `--registry=${registry}`], { cwd })
  return JSON.parse(result.stdout)
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
  if (!dryRun.stdout.includes('[cordisx] bundle ready:') || !dryRun.stdout.includes('"status": "ready"')) {
    throw new Error('registry-generated plugin failed cordisx dev --dry-run')
  }
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-registry-beta-'))
try {
  const runner = path.join(temporaryRoot, 'runner')
  const cordisxHome = path.join(temporaryRoot, 'cordisx-home')
  await mkdir(runner, { recursive: true })
  await writeFile(path.join(runner, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`, 'utf8')
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
  await run('npm', [
    'create', 'cordisx-plugin@beta', createTarget,
  ], { cwd: runner })
  await run('npx', ['--yes', 'create-cordisx-plugin@beta', npxTarget], { cwd: runner })
  await verifyGeneratedProject(createTarget)
  await verifyGeneratedProject(npxTarget)

  for (const packageName of ['cordisx', 'create-cordisx-plugin']) {
    const tags = await npmJson(['view', packageName, 'dist-tags'], runner)
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
    latest: '0.0.0',
  }))
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
