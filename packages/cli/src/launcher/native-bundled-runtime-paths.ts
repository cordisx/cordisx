import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A failed or unrecognized version never advertises version-specific native capabilities. */
export async function bundledCodexVersion(cli: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(cli, ['--version'], { timeout: 5_000, maxBuffer: 4096 })
    const value = result.stdout.trim()
    return /^codex-cli [A-Za-z0-9.+-]{1,100}$/u.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Resolve only CLI binaries bundled inside the selected Desktop app. */
export async function resolveBundledCodexCliPath(contents: string): Promise<string> {
  for (const relative of ['Resources/codex', 'Resources/codex-cli/bin/codex']) {
    const candidate = path.join(contents, relative)
    let resolved: string
    try {
      resolved = await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    await access(resolved, constants.X_OK)
    return resolved
  }
  throw new Error('The selected Desktop app does not contain a supported bundled Codex CLI')
}

/** Keep the intermediary inside the selected App's signed runtime chain, without changing the Host's Node. */
export async function resolveBundledCodexNodePath(contents: string): Promise<string> {
  const resources = await realpath(path.join(contents, 'Resources'))
  let runtime: string
  try {
    runtime = await realpath(path.join(resources, 'cua_node/bin/node'))
  } catch (error) {
    throw new Error('The selected Desktop app does not contain its bundled intermediary Node runtime', { cause: error })
  }
  if (!runtime.startsWith(`${resources}${path.sep}`)) {
    throw new Error('The intermediary Node runtime must remain inside the selected Desktop app')
  }
  await access(runtime, constants.X_OK)
  return runtime
}
