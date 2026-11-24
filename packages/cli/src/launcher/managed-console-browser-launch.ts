import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type ManagedConsoleBrowserGateway,
  MAX_STANDALONE_CONSOLE_ORIGINS,
  openManagedConsoleBrowserGateway,
} from './managed-console-browser-gateway.js'
import type { ManagedBrowserConsoleBoundary } from './managed-service-browser-console-broker.js'

/** App builds whose browser resolver and cookie boundary have native evidence. */
const VERIFIED_CODE_DIRECTORIES = new Map([
  ['25679', 'f056dea6c8c27d5221903826d59e2becfa209a4d'],
  ['25894', '699937d138fa785a0e6c724bbc5d01f243f4e4a4'],
])

export function verifiedManagedConsoleBrowserApp(executable: string, build: string, signature: string): boolean {
  const hash = VERIFIED_CODE_DIRECTORIES.get(build.trim())
  const fields = new Set(signature.split(/\r?\n/u))
  return hash !== undefined && fields.has('Executable=' + executable)
    && fields.has('Identifier=com.openai.codex') && fields.has('TeamIdentifier=2DC432GLL2')
    && fields.has('CDHash=' + hash)
}

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
    return !signal.aborted && verifiedManagedConsoleBrowserApp(executable, build.stdout, signature.stderr)
  } catch {
    return false
  }
}

/** The launcher owns the resolver and gateway for the lifetime of its isolated App. */
export class ManagedConsoleBrowserLaunch {
  private gateway: ManagedConsoleBrowserGateway | undefined
  private standaloneGateways: readonly ManagedConsoleBrowserGateway[] = []
  private standaloneBoundary: ManagedBrowserConsoleBoundary | undefined
  private ready = false
  private preparingStandalone = false

  readonly boundary = () => this.ready ? this.gateway?.boundary ?? this.standaloneBoundary : undefined

  async prepare(executable: string, hostArgs: readonly string[], signal: AbortSignal): Promise<readonly string[]> {
    if (!await supportsManagedConsoleBrowserLaunch(executable, hostArgs, signal)) return hostArgs
    this.gateway = await openManagedConsoleBrowserGateway().catch(() => undefined)
    signal.throwIfAborted()
    return this.gateway ? [...hostArgs, this.gateway.hostArgument] : hostArgs
  }

  /** A standalone Manager uses the browser's localhost handling and a separate origin. */
  async prepareStandalone(signal: AbortSignal): Promise<readonly string[]> {
    if (
      signal.aborted || this.gateway !== undefined || this.standaloneGateways.length > 0 || this.preparingStandalone
    ) {
      throw new Error('managed browser console unavailable')
    }
    this.preparingStandalone = true
    const gateways: ManagedConsoleBrowserGateway[] = []
    try {
      for (let index = 0; index < MAX_STANDALONE_CONSOLE_ORIGINS; index++) {
        signal.throwIfAborted()
        gateways.push(await openManagedConsoleBrowserGateway())
      }
      signal.throwIfAborted()
      this.standaloneGateways = gateways
      this.standaloneBoundary = {
        open(input) {
          for (const gateway of gateways) {
            const route = gateway.boundary.open(input)
            if (route) return route
          }
          return undefined
        },
      }
      this.ready = true
      return gateways.map(gateway => gateway.origin)
    } catch (error) {
      await Promise.allSettled(gateways.map(async gateway => await gateway.close()))
      throw error
    } finally {
      this.preparingStandalone = false
    }
  }

  markReady() {
    this.ready = this.gateway !== undefined
  }

  async close() {
    this.ready = false
    const gateway = this.gateway
    const standalone = this.standaloneGateways
    this.gateway = undefined
    this.standaloneGateways = []
    this.standaloneBoundary = undefined
    await Promise.all([...(gateway ? [gateway] : []), ...standalone].map(async item => await item.close()))
  }
}
