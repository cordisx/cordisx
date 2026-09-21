#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { npmPackItem } from './npm-pack-report.mjs'
import { sha256File, verifyInstalledPackage } from './local-candidate-acceptance-lib.mjs'
import {
  acceptanceEnvironment,
  assertNoAuthenticationMaterial,
  cleanupAcceptanceProfile,
  prepareAcceptanceProfile,
  redactAcceptanceText,
  sanitizeAcceptanceReport,
} from '../packages/cli/scripts/local-acceptance-paths.mjs'

const execute = promisify(execFile)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPORT_SCHEMA = 'cordisx.local-candidate-acceptance/v1'
const WORK_PREFIX = 'cordisx-local-candidate-work-'

function usage() {
  return `Usage: npm run acceptance:local-candidate -- [options]\n\nOptions:\n  --artifacts <absolute dir>    New evidence directory (default: artifacts/local-candidate-acceptance/<timestamp>)\n  --profile-root <absolute dir> Reuse a dedicated acceptance profile across runs\n  --temporary-profile          Use and remove a runner-created profile (default)\n  --executable <absolute path>  Host executable; otherwise discover Codex/ChatGPT on macOS\n  --package-only               Pack, install, and inspect candidates without starting a Host\n  --real-message               Explicitly run the live model-message harness after safe checks\n  --timeout-ms <milliseconds>   Host checkpoint timeout (default: 120000)\n  --cleanup-profile <absolute>  Remove a marked persistent acceptance profile and exit\n  --help                        Show this help\n`
}

function parseArgs(argv) {
  const options = { temporaryProfile: true, packageOnly: false, realMessage: false, timeoutMs: 120_000 }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--help') return { help: true }
    if (option === '--temporary-profile') {
      options.temporaryProfile = true
      continue
    }
    if (option === '--package-only') {
      options.packageOnly = true
      continue
    }
    if (option === '--real-message') {
      options.realMessage = true
      continue
    }
    if (!['--artifacts', '--profile-root', '--executable', '--timeout-ms', '--cleanup-profile'].includes(option)) {
      throw new Error(`unknown option: ${option}`)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
    options[option.slice(2)] = value
    index += 1
  }
  if (options['profile-root'] !== undefined) options.temporaryProfile = false
  for (const name of ['artifacts', 'profile-root', 'executable', 'cleanup-profile']) {
    if (options[name] !== undefined && !path.isAbsolute(options[name])) throw new Error(`--${name} must be absolute`)
  }
  options.timeoutMs = Number(options['timeout-ms'] ?? options.timeoutMs)
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 5_000 || options.timeoutMs > 120_000) {
    throw new Error('--timeout-ms must be an integer between 5000 and 120000')
  }
  if (
    options['cleanup-profile'] !== undefined
    && Object.keys(options).some(key =>
      !['cleanup-profile', 'temporaryProfile', 'packageOnly', 'realMessage', 'timeoutMs'].includes(key)
    )
  ) throw new Error('--cleanup-profile cannot be combined with acceptance options')
  if (options.packageOnly && options.realMessage) {
    throw new Error('--real-message cannot be combined with --package-only')
  }
  return options
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
}

async function exists(target) {
  return await access(target).then(() => true, error => {
    if (error?.code === 'ENOENT') return false
    throw error
  })
}

async function run(command, args, options = {}) {
  let result
  try {
    result = await execute(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    error.commandOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (options.log !== undefined) await writeFile(options.log, error.commandOutput, { mode: 0o600 })
    throw error
  }
  if (options.log !== undefined) {
    await writeFile(options.log, `${result.stdout}${result.stderr}`, { mode: 0o600 })
  }
  return result
}

async function sanitizeTextArtifacts(root, replacements) {
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && ['.json', '.log'].includes(path.extname(entry.name))) {
        const text = await readFile(target, 'utf8')
        let sanitized
        if (path.extname(entry.name) === '.json') {
          try {
            sanitized = `${JSON.stringify(sanitizeAcceptanceReport(JSON.parse(text), replacements), null, 2)}\n`
          } catch {
            sanitized = redactAcceptanceText(text, replacements)
          }
        } else sanitized = redactAcceptanceText(text, replacements)
        await writeFile(target, sanitized, { mode: 0o600 })
      }
    }
  }
  await visit(root)
}

async function packWorkspace(name, workspace, packDir, logPath) {
  const { stdout } = await run(
    'npm',
    ['pack', '--json', '--pack-destination', packDir, `--workspace=${workspace}`],
    { cwd: repositoryRoot, log: logPath },
  )
  const item = npmPackItem(JSON.parse(stdout), name)
  const tarball = path.join(packDir, item.filename)
  if (!await exists(tarball)) throw new Error(`npm pack did not create ${item.filename}`)
  const files = Array.isArray(item.files) ? item.files.map(file => file.path) : []
  assertNoAuthenticationMaterial(files)
  return {
    name,
    version: item.version,
    filename: item.filename,
    digest: `sha256:${await sha256File(tarball)}`,
    integrity: item.integrity ?? null,
    fileCount: files.length,
    tarball,
  }
}

function executableCandidates(explicit) {
  if (explicit !== undefined) return [explicit]
  return [
    '/Applications/Codex.app/Contents/MacOS/Codex',
    '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    path.join(os.homedir(), 'Applications/Codex.app/Contents/MacOS/Codex'),
    path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
  ]
}

async function discoverExecutable(explicit) {
  for (const candidate of executableCandidates(explicit)) if (await exists(candidate)) return candidate
  throw new Error('Host executable was not found; pass --executable or use --package-only')
}

async function hostBuild(executable) {
  if (process.platform !== 'darwin') return { executable: path.basename(executable), platform: process.platform }
  const appRoot = path.resolve(executable, '../../..')
  const read = async key =>
    (await run('plutil', ['-extract', key, 'raw', '-o', '-', path.join(appRoot, 'Contents', 'Info.plist')])).stdout
      .trim()
  return {
    executable: path.basename(executable),
    bundleId: await read('CFBundleIdentifier'),
    version: await read('CFBundleShortVersionString'),
    build: await read('CFBundleVersion'),
  }
}

let options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(usage())
  process.exit(2)
}
if (options.help) {
  console.log(usage())
  process.exit(0)
}
if (options['cleanup-profile'] !== undefined) {
  console.log(JSON.stringify(await cleanupAcceptanceProfile(options['cleanup-profile']), null, 2))
  process.exit(0)
}

const artifacts = options.artifacts ?? path.join(repositoryRoot, 'artifacts', 'local-candidate-acceptance', stamp())
if (await exists(artifacts)) throw new Error(`--artifacts must name a new directory: ${artifacts}`)
await mkdir(artifacts, { recursive: true, mode: 0o700 })
const workingRoot = await mkdtemp(path.join(os.tmpdir(), WORK_PREFIX))
const packDir = path.join(workingRoot, 'packs')
const installPrefix = path.join(workingRoot, 'prefix')
await mkdir(packDir, { recursive: true, mode: 0o700 })
await mkdir(installPrefix, { recursive: true, mode: 0o700 })
const profile = await prepareAcceptanceProfile(options['profile-root'])
const canonicalPaths = {
  artifacts: await realpath(artifacts),
  profile: await realpath(profile.root),
  repository: await realpath(repositoryRoot),
  working: await realpath(workingRoot),
}
const reportPath = path.join(artifacts, 'acceptance-report.json')
const report = {
  $schema: REPORT_SCHEMA,
  schemaVersion: 1,
  result: 'failed',
  startedAt: new Date().toISOString(),
  source: {
    commit: (await run('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim(),
    dirty:
      (await run('git', ['status', '--porcelain=v1', '--untracked-files=no'], { cwd: repositoryRoot })).stdout.trim()
        !== '',
  },
  mode: { packageOnly: options.packageOnly, temporaryProfile: profile.temporary, realMessages: options.realMessage },
  paths: {
    artifacts,
    cordisxHome: profile.cordisxHome,
    chromiumProfile: profile.chromiumProfile,
    profileRoot: profile.root,
  },
  artifacts: {
    report: reportPath,
    logs: [
      path.join(artifacts, 'pack-cordisx.log'),
      path.join(artifacts, 'pack-create-cordisx-plugin.log'),
      path.join(artifacts, 'install.log'),
    ],
    screenshots: [],
  },
  packages: {},
  host: { result: options.packageOnly ? 'skipped' : 'pending', build: null, report: null, logs: [], screenshots: [] },
  stages: [],
  cleanup: {},
}

let failure
try {
  report.stages.push({ name: 'pack', result: 'started' })
  const cordisx = await packWorkspace('cordisx', 'cordisx', packDir, path.join(artifacts, 'pack-cordisx.log'))
  const creator = await packWorkspace(
    'create-cordisx-plugin',
    'create-cordisx-plugin',
    packDir,
    path.join(artifacts, 'pack-create-cordisx-plugin.log'),
  )
  report.stages.at(-1).result = 'passed'

  report.stages.push({ name: 'install', result: 'started' })
  await run(
    'npm',
    ['install', '--prefix', installPrefix, '--no-audit', '--no-fund', cordisx.tarball, creator.tarball],
    { cwd: workingRoot, log: path.join(artifacts, 'install.log') },
  )
  const installedCordisx = await verifyInstalledPackage(installPrefix, cordisx, 'cordisx', run)
  const installedCreator = await verifyInstalledPackage(installPrefix, creator, 'create-cordisx-plugin', run)
  report.packages = {
    cordisx: { ...cordisx, tarball: cordisx.filename, installed: installedCordisx },
    createCordisXPlugin: { ...creator, tarball: creator.filename, installed: installedCreator },
  }
  report.stages.at(-1).result = 'passed'

  if (!options.packageOnly) {
    report.stages.push({ name: 'host', result: 'started' })
    const executable = await discoverExecutable(options.executable)
    report.host.build = await hostBuild(executable)
    const checkpointRoot = path.join(artifacts, 'host-checkpoint')
    const checkpointLog = path.join(artifacts, 'host-checkpoint-command.log')
    const cliBin = path.join(installPrefix, 'node_modules', '.bin', 'cordisx')
    await run(process.execPath, [
      path.join(repositoryRoot, 'packages/cli/scripts/checkpoint-local-dev.mjs'),
      '--executable',
      executable,
      '--artifacts',
      checkpointRoot,
      '--repo-root',
      repositoryRoot,
      '--cli-bin',
      cliBin,
      '--cordisx-home',
      profile.cordisxHome,
      '--profile-dir',
      profile.chromiumProfile,
      '--source-root',
      profile.fixtureRoot,
      '--session-boundary',
      '--timeout-ms',
      String(options.timeoutMs),
    ], {
      cwd: repositoryRoot,
      env: acceptanceEnvironment(process.env, profile.cordisxHome),
      log: checkpointLog,
    })
    const checkpointReportPath = path.join(checkpointRoot, 'artifacts', 'checkpoint-report.json')
    const checkpoint = JSON.parse(await readFile(checkpointReportPath, 'utf8'))
    report.host = {
      result: checkpoint.result,
      build: report.host.build,
      report: checkpointReportPath,
      candidateBoundary: checkpoint.stages?.candidateBoundary ?? null,
      logs: [checkpointLog, checkpoint.artifacts?.launcherLog].filter(Boolean),
      screenshots: [
        checkpoint.artifacts?.initialScreenshot,
        checkpoint.artifacts?.failedScreenshot,
        checkpoint.artifacts?.finalScreenshot,
      ].filter(Boolean),
      cleanup: checkpoint.cleanup,
    }
    report.artifacts.logs.push(...report.host.logs)
    report.artifacts.screenshots.push(...report.host.screenshots)
    report.stages.at(-1).result = checkpoint.result
    if (options.realMessage) {
      report.stages.push({ name: 'real-message', result: 'started' })
      const messageReport = path.join(artifacts, 'real-message-report.json')
      await run(process.execPath, [
        path.join(repositoryRoot, 'packages/cli/scripts/run-codex-desktop-agent-session-harness.mjs'),
        '--report',
        messageReport,
        '--executable',
        executable,
        '--cli-bin',
        cliBin,
      ], {
        cwd: repositoryRoot,
        env: acceptanceEnvironment(process.env, profile.cordisxHome),
        log: path.join(artifacts, 'real-message-command.log'),
      })
      report.host.realMessageReport = messageReport
      report.artifacts.logs.push(path.join(artifacts, 'real-message-command.log'))
      report.stages.at(-1).result = 'passed'
    }
  }
  report.result = 'passed'
} catch (error) {
  failure = error
  const stage = report.stages.at(-1)
  if (stage?.result === 'started') stage.result = 'failed'
  report.error = { message: error instanceof Error ? error.message : String(error) }
} finally {
  try {
    await rm(workingRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    report.cleanup.workingRoot = { removed: !await exists(workingRoot) }
  } catch (error) {
    report.cleanup.workingRoot = { removed: false, error: error instanceof Error ? error.message : String(error) }
    failure ??= error
  }
  try {
    if (profile.temporary) report.cleanup.profile = await cleanupAcceptanceProfile(profile.root)
    else report.cleanup.profile = { requested: false, removed: false, retained: true }
  } catch (error) {
    report.cleanup.profile = {
      requested: true,
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    }
    failure ??= error
  }
  if (failure !== undefined) {
    report.result = 'failed'
    report.error ??= { message: failure instanceof Error ? failure.message : String(failure) }
  }
  report.finishedAt = new Date().toISOString()
  const replacements = [
    [workingRoot, '$WORK_ROOT'],
    [canonicalPaths.working, '$WORK_ROOT'],
    [profile.root, '$PROFILE_ROOT'],
    [canonicalPaths.profile, '$PROFILE_ROOT'],
    [artifacts, '$ARTIFACTS'],
    [canonicalPaths.artifacts, '$ARTIFACTS'],
    [repositoryRoot, '$REPOSITORY'],
    [canonicalPaths.repository, '$REPOSITORY'],
    [process.env.CODEX_HOME, '$CODEX_HOME'],
    [process.env.HOME, '$HOME'],
  ].filter(([target]) => typeof target === 'string').sort((left, right) => right[0].length - left[0].length)
  await sanitizeTextArtifacts(artifacts, replacements)
  const sanitized = sanitizeAcceptanceReport(report, replacements)
  await writeFile(reportPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 })
  console.log(`acceptance-report=${reportPath}`)
}

if (failure !== undefined) {
  console.error(`local candidate acceptance failed; see ${reportPath}`)
  process.exitCode = 1
}
