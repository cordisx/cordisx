import { execFile } from 'node:child_process'
import { access, constants, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { TerminalInvocation } from './terminal-parse.js'

const VERSION_TIMEOUT_MS = 5_000
const VERSION_OUTPUT_LIMIT = 16 * 1024

export function terminalClientName(client: TerminalInvocation['client']): string {
  return client === 'claude-code' ? 'Claude Code' : 'Codex'
}

async function resolveClient(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const explicitPath = path.isAbsolute(executable) || executable.includes('/') || executable.includes('\\')
  const pathKey = Object.keys(env).find(key =>
    process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH'
  )
  const searchPath = pathKey === undefined ? process.platform === 'win32' ? '' : '/usr/bin:/bin' : env[pathKey] ?? ''
  const candidates = explicitPath
    ? [path.resolve(cwd, executable)]
    : searchPath.split(path.delimiter).flatMap(directory => {
      const candidate = path.resolve(cwd, directory, executable)
      return process.platform === 'win32' && !path.extname(executable) ? [candidate, `${candidate}.exe`] : [candidate]
    })
  for (const candidate of candidates) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      // Let execFile report permissions for explicit paths rather than calling them missing.
      if (!explicitPath) await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch { /* Match PATH lookup: skip files that cannot be executed. */ }
  }
}

function installAdvice(client: TerminalInvocation['client'], executable: string, target: string): string {
  if (client === 'claude-code') return 'Install or repair Claude Code: https://code.claude.com/docs/en/setup'
  const normalized = `${executable}\n${target}`.replaceAll('\\', '/')
  if (/(?:^|\/)pnpm(?:\/|$)/u.test(normalized)) {
    return 'Repair the pnpm installation: pnpm add -g @openai/codex@latest --force'
  }
  if (/\/(?:Cellar|Caskroom)\/codex\//u.test(normalized)) {
    return 'Repair the Homebrew installation: brew reinstall --cask codex'
  }
  return 'Install or repair Codex CLI: npm install -g @openai/codex@latest'
}

function diagnostic(
  client: TerminalInvocation['client'],
  executable: string,
  target: string,
  reason: string,
): Error {
  const name = terminalClientName(client)
  const command = client === 'claude-code' ? 'claude' : 'codex'
  return new Error([
    `${name} CLI ${reason}`,
    `Selected executable: ${JSON.stringify(executable)}`,
    installAdvice(client, executable, target),
    `Then run ${command} --version in this terminal. If PATH still selects an old entry, fix PATH or open a new terminal.`,
    'To use another installation, add --executable /absolute/path/to/the-cli to the CordisX command.',
    ...(client === 'claude-code' ? [] : ['Codex installation guide: https://learn.chatgpt.com/docs/codex/cli']),
  ].join('\n'))
}

/** Probe the exact selected entry before acquiring a provider lease; never print client output. */
export async function checkTerminalClient(
  executable: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; client: TerminalInvocation['client']; signal?: AbortSignal },
): Promise<string> {
  options.signal?.throwIfAborted()
  const selected = await resolveClient(executable, options.cwd, options.env)
  if (!selected) {
    throw diagnostic(options.client, executable, '', 'was not found. Install it or correct the executable path.')
  }
  const target = await realpath(selected).catch(() => selected)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
  for (const signal of signals) process.once(signal, abort)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(selected, ['--version'], {
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
        timeout: VERSION_TIMEOUT_MS,
        maxBuffer: VERSION_OUTPUT_LIMIT,
        killSignal: 'SIGKILL',
        windowsHide: true,
        signal: controller.signal,
      }, (error, stdout, stderr) => {
        if (!error) return resolve()
        if (controller.signal.aborted) {
          return reject(new Error(`${terminalClientName(options.client)} CLI startup check cancelled`))
        }
        // Only recognized failure categories cross this boundary, never arbitrary output or stack traces.
        const output = `${stdout}\n${stderr}`
        const reason = error.code === 'EACCES' || error.code === 'EPERM'
          ? 'cannot be executed (permission denied). Check its file permissions or reinstall it.'
          : error.code === 'ENOENT'
          ? 'entry exists, but its executable or interpreter is missing. Repair the installation and runtime PATH.'
          : /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|Missing optional dependency/u
              .test(output)
          ? 'installation is incomplete: its launcher references missing files or dependencies.'
          : /(?:node|nodejs): (?:command )?not found|env:.*(?:node|nodejs).*No such file/u.test(output)
          ? 'launcher cannot find Node.js. Restore Node.js on PATH or use a standalone CLI installation.'
          : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'version check exceeded its output limit. Run the selected executable with --version to inspect it.'
          : error.killed
          ? 'version check timed out after 5 seconds. Run the selected executable with --version to inspect it.'
          : `failed its --version startup check (${
            typeof error.code === 'number' ? `exit ${error.code}` : 'execution error'
          }).`
        reject(diagnostic(options.client, selected, target, reason))
      })
    })
    return selected
  } finally {
    for (const signal of signals) process.off(signal, abort)
    options.signal?.removeEventListener('abort', abort)
  }
}
