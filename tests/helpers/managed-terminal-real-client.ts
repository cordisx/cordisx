import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runCordisXCli } from '../../packages/cli/src/cli/run.js'

/** Optional local smoke using the installed Codex and a synthetic loopback provider. */
export async function exerciseInstalledCodex(input: {
  readonly root: string
  readonly cert: string
  readonly port: number
  readonly profile: string
  readonly providerId: string
  readonly env: NodeJS.ProcessEnv
}): Promise<boolean> {
  const requested = process.env.CORDISX_TEST_REAL_CODEX_CLI
  if (!requested) return false
  const authFile = process.env.CORDISX_TEST_CODEX_AUTH_FILE
  if (process.platform !== 'darwin' || !authFile) {
    throw new Error('Isolated Codex smoke requires an authentication copy')
  }
  const [executable, node, helperRoot] = await Promise.all([
    realpath(requested),
    realpath(process.execPath),
    realpath(path.resolve('packages/cli/dist/assets/launcher')),
  ])
  const codexHome = path.join(input.root, 'codex-home')
  await mkdir(codexHome, { mode: 0o700 })
  await copyFile(authFile, path.join(codexHome, 'auth.json'))
  await chmod(path.join(codexHome, 'auth.json'), 0o600)
  const allowed = [
    input.root,
    path.dirname(path.dirname(node)),
    path.dirname(path.dirname(executable)),
    helperRoot,
    '/private/etc',
    '/private/var/db/dyld',
    '/private/var/db/timezone',
  ]
  const policy = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(allow network-outbound (remote ip "localhost:${input.port}"))`,
    `(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(input.root)})))`,
    '(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/Library") (subpath "/private"))',
    '(allow file-read-data ' + allowed.map(directory => `(subpath ${JSON.stringify(directory)})`).join(' ') + ')',
    '(deny file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/Library") (subpath "/private"))',
    `(allow file-write* (subpath ${JSON.stringify(input.root)}))`,
    '(deny mach-lookup (global-name "com.apple.securityd"))',
  ].join('\n')
  let child: ChildProcess | undefined
  let output = ''
  let errors = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await runCordisXCli([
      'start',
      '--mode',
      'cli',
      'codex',
      '--profile',
      input.profile,
      '-s',
      input.providerId,
      '-m',
      'fixture-model',
      '--',
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--ignore-user-config',
      '--disable',
      'plugins',
      '--disable',
      'apps',
      '--disable',
      'computer_use',
      '--disable',
      'browser_use',
      'Reply with one word.',
    ], {
      cwd: input.root,
      homedir: input.root,
      env: {
        ...input.env,
        HOME: input.root,
        CODEX_HOME: codexHome,
        TMPDIR: input.root,
        SSL_CERT_FILE: input.cert,
        CI: '1',
        ...(process.env.CORDISX_TEST_CODEX_LOG === undefined ? {} : { RUST_LOG: process.env.CORDISX_TEST_CODEX_LOG }),
      },
      internalCheckTerminalClient: async () => executable,
      internalSpawnTerminal: ((_executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        child = spawn('/usr/bin/sandbox-exec', ['-p', policy, executable, ...args], {
          cwd: input.root,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout!.setEncoding('utf8').on('data', chunk => {
          output += chunk
        })
        child.stderr!.setEncoding('utf8').on('data', chunk => {
          errors = (errors + chunk).slice(-32_768)
        })
        const requestedTimeout = Number(process.env.CORDISX_TEST_CODEX_TIMEOUT_MS ?? 45_000)
        const timeout = Number.isFinite(requestedTimeout) ? Math.max(5_000, Math.min(45_000, requestedTimeout)) : 45_000
        timer = setTimeout(() => child?.kill('SIGTERM'), timeout)
        return child
      }) as typeof spawn,
    })
    if (!output.includes('local fixture response')) throw new Error('Codex did not return the synthetic response')
    return true
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const diagnostic = process.env.CORDISX_TEST_CODEX_DIAGNOSTIC
    if (diagnostic) await writeFile(diagnostic, JSON.stringify({ output, errors }), { mode: 0o600 })
  }
}
