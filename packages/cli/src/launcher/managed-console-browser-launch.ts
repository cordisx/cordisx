import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type ManagedConsoleBrowserGateway,
  openManagedConsoleBrowserGateway,
} from './managed-console-browser-gateway.js'

/** The browser resolver and cookie boundary was exercised against this signed App build. */
const VERIFIED_CODE_DIRECTORY = 'f056dea6c8c27d5221903826d59e2becfa209a4d'

export async function supportsManagedConsoleBrowserLaunch(
  executable: string,
  hostArgs: readonly string[],
  signal: AbortSignal,
): Promise<boolean> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || hostArgs.length !== 0 || signal.aborted) {
    return false
  }
  const contents = path.dirname(path.dirname(executable))
  const app = path.dirname(contents)
  if (path.basename(contents) !== 'Contents' || !app.endsWith('.app')) return false
  const execute = promisify(execFile)
  try {
    const [signature, build] = await Promise.all([
      execute('/usr/bin/codesign', ['--display', '--verbose=4', app], { signal, timeout: 2_000 }),
      execute('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', path.join(contents, 'Info.plist')], {
        signal,
        timeout: 2_000,
      }),
      execute('/usr/bin/codesign', ['--verify', '--strict', '--deep', '--ignore-resources', app], {
        signal,
        timeout: 2_000,
      }),
    ])
    const fields = new Set(signature.stderr.split(/\r?\n/u))
    return !signal.aborted && build.stdout.trim() === '25679'
      && fields.has('Executable=' + executable) && fields.has('Identifier=com.openai.codex')
      && fields.has('TeamIdentifier=2DC432GLL2')
      && fields.has('CDHash=' + VERIFIED_CODE_DIRECTORY)
  } catch {
    return false
  }
}

/** The launcher owns the resolver and gateway for the lifetime of its isolated App. */
export class ManagedConsoleBrowserLaunch {
  private gateway: ManagedConsoleBrowserGateway | undefined
  private ready = false

  readonly boundary = () => this.ready ? this.gateway?.boundary : undefined

  async prepare(executable: string, hostArgs: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
    if (!await supportsManagedConsoleBrowserLaunch(executable, hostArgs, signal)) return hostArgs
    this.gateway = await openManagedConsoleBrowserGateway().catch(() => undefined)
    signal.throwIfAborted()
    return this.gateway ? [...hostArgs, this.gateway.hostArgument] : hostArgs
  }

  markReady() {
    this.ready = this.gateway !== undefined
  }

  async close() {
    this.ready = false
    const gateway = this.gateway
    this.gateway = undefined
    await gateway?.close()
  }
}
