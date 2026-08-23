import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))

async function run(file, args, options = {}) {
  try {
    return await execute(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr : ''
    throw new Error(
      `${file} ${args.join(' ')} failed\n${stdout}${stderr}`,
      { cause: error },
    )
  }
}

function parsePackReport(stdout) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`npm pack did not return JSON:\n${stdout}`, { cause: error })
  }
  const filename = report[0]?.filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('npm pack did not report a tarball filename')
  }
  return filename
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

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-installed-check-'))
try {
  const packDirectory = path.join(temporaryRoot, 'pack')
  const installDirectory = path.join(temporaryRoot, 'install')
  const cordisxHome = path.join(temporaryRoot, 'cordisx-home')
  await mkdir(packDirectory, { recursive: true })
  await mkdir(installDirectory, { recursive: true })
  await writeFile(
    path.join(installDirectory, 'package.json'),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
    'utf8',
  )

  const packed = await run('npm', [
    'pack',
    '--workspace=cordisx',
    '--pack-destination',
    packDirectory,
    '--json',
  ], { cwd: repositoryRoot, env: process.env })
  const tarball = path.join(packDirectory, parsePackReport(packed.stdout))

  await run('npm', [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
    tarball,
  ], { cwd: installDirectory, env: process.env })

  const bin = path.join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'cordisx.cmd' : 'cordisx',
  )
  const cliEnvironment = { ...process.env, CORDISX_HOME: cordisxHome }
  const help = await run(bin, ['--help'], { cwd: installDirectory, env: cliEnvironment })
  if (!help.stdout.includes('cordisx setup')) throw new Error('installed cordisx --help is incomplete')

  await run(bin, ['setup'], { cwd: installDirectory, env: cliEnvironment })
  const configPath = path.join(cordisxHome, 'config.json')
  const initialConfig = JSON.parse(await readFile(configPath, 'utf8'))
  if (!Array.isArray(initialConfig.plugins) || initialConfig.plugins.length !== 0) {
    throw new Error('installed cordisx setup must create plugins: []')
  }

  const config = await run(bin, ['config'], { cwd: installDirectory, env: cliEnvironment })
  if (!config.stdout.includes(configPath)) throw new Error('installed cordisx config did not report its home config')

  const doctor = await run(bin, ['doctor'], { cwd: installDirectory, env: cliEnvironment })
  if (!doctor.stdout.includes('"status"')) throw new Error('installed cordisx doctor did not report a status')

  const profileRoot = path.join(cordisxHome, 'apps', 'codex', 'profiles', 'work')
  await run(bin, [
    'codex',
    'work',
    '--dry-run',
    '--executable',
    process.execPath,
  ], { cwd: installDirectory, env: cliEnvironment })

  const persistedConfig = JSON.parse(await readFile(configPath, 'utf8'))
  const workProfile = persistedConfig.apps?.codex?.profiles?.work
  if (workProfile?.dataMode !== 'isolated') {
    throw new Error('installed cordisx dry-run must persist a new work profile as isolated')
  }
  await expectMissing(profileRoot, 'named profile data directory')

  console.log('[cordisx] installed tarball verified: help, setup, config, doctor, isolated profile dry-run')
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
