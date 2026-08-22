import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'

async function firstExisting(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate
  }
}

/** Resolve the native Codex executable without reading or changing its profile. */
export async function resolveCodexExecutable(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit)
    await access(resolved)
    return resolved
  }
  const candidates = process.platform === 'darwin'
    ? [
        '/Applications/Codex.app/Contents/MacOS/Codex',
        path.join(os.homedir(), 'Applications/Codex.app/Contents/MacOS/Codex'),
        '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
        path.join(os.homedir(), 'Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
      ]
    : process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Codex', 'Codex.exe'),
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ChatGPT', 'ChatGPT.exe'),
        ]
      : []
  const found = await firstExisting(candidates)
  if (found === undefined) throw new Error('Codex/ChatGPT executable not found; pass --executable <path> or use --attach')
  return found
}

/** Launch Codex with a loopback-only DevTools endpoint. */
export function launchCodex(executable: string, debugPort: number, extraArgs: readonly string[]): ChildProcess {
  return spawn(executable, [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=http://127.0.0.1:${debugPort}`,
    ...extraArgs,
  ], {
    stdio: 'inherit',
    env: process.env,
  })
}
