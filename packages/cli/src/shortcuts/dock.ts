import { connect, createConnection } from 'node:net'
import { chmod, lstat, open, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CdpSession, runtimeEvaluationException } from '../launcher/cdp-session.js'
import { hasMatchingProcessIdentity } from '../cli/supervisor-state.js'
import { inspectBundle, nativeOperation } from './native.js'
import { readPrivateJson } from './store.js'
import { validRecord } from './model.js'

export const dockAgent = fileURLToPath(new URL('../../native/dock-agent.cjs', import.meta.url))
const run = promisify(execFile)
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX')

/** This is a read-only Electron fuse preflight; unknown versions fail closed. */
export async function supportsOwnedMainInspector(executable: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    const resolved = await realpath(executable)
    const bundle = path.resolve(path.dirname(resolved), '../..')
    if (!bundle.endsWith('.app')) return false
    const { stdout } = await run('/usr/bin/plutil', [
      '-extract',
      'CFBundleIdentifier',
      'raw',
      path.join(bundle, 'Contents/Info.plist'),
    ])
    if (stdout.trim() !== 'com.openai.codex') return false
    const framework = await open(
      path.join(
        bundle,
        'Contents/Frameworks/Codex Framework.framework/Versions/Current/Codex Framework',
      ),
      'r',
    )
    try {
      const block = Buffer.alloc(1024 * 1024 + FUSE_SENTINEL.length + 16)
      const info = await framework.stat()
      for (let offset = 0; offset < info.size; offset += 1024 * 1024) {
        const { bytesRead } = await framework.read(block, 0, block.length, offset)
        const index = block.subarray(0, bytesRead).indexOf(FUSE_SENTINEL)
        if (index < 0) continue
        const wire = block.subarray(index + FUSE_SENTINEL.length, bytesRead)
        // Electron Fuse V1, nine known bits; index 3 is nodeCliInspect.
        return wire.length >= 11 && wire[0] === 1 && wire[1] === 9
          && wire.subarray(2, 11).every(value => value === 48 || value === 49)
          && wire[2 + 3] === 49
      }
    } finally {
      await framework.close()
    }
  } catch { /* Unknown Host bundles keep ordinary launch behavior. */ }
  return false
}
export interface DockScope {
  readonly entryId: string
  readonly recordPath: string
  readonly directory: string
  readonly socketPath: string
  readonly iconPath: string
  readonly lightIconPath: string
  readonly darkIconPath: string
  readonly defaultIconPath: string
}

export function dockScope(entryId: string, recordPath: string, directory: string): DockScope {
  if (!/^[a-f0-9]{32}$/u.test(entryId) || !path.isAbsolute(recordPath) || !path.isAbsolute(directory)) {
    throw new Error('Invalid Dock entry scope')
  }
  return {
    entryId,
    recordPath,
    directory,
    socketPath: path.join(directory, 'dock.sock'),
    iconPath: path.join(directory, 'dock.png'),
    lightIconPath: path.join(directory, 'dock-light.png'),
    darkIconPath: path.join(directory, 'dock-dark.png'),
    defaultIconPath: path.join(directory, 'dock-default.png'),
  }
}

async function clearDockImages(scope: DockScope): Promise<void> {
  await Promise.all([scope.iconPath, scope.lightIconPath, scope.darkIconPath, scope.defaultIconPath]
    .map(file => rm(file, { force: true })))
}

/** The only image source is the inspected, currently saved Finder entry. */
export async function prepareDockImage(
  scope: DockScope,
  expected: { home: string; app: string; profile: string },
): Promise<boolean> {
  let value: unknown
  try {
    value = await readPrivateJson(scope.recordPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await clearDockImages(scope)
      return false
    }
    throw error
  }
  if (
    !validRecord(value) || value.entryId !== scope.entryId || value.cordisxHome !== expected.home
    || value.appId !== expected.app || value.profileId !== expected.profile
  ) throw new Error('Dock record identity mismatch')
  const resolved = await nativeOperation<{ path: string }>({ operation: 'resolve', bookmark: value.bookmark })
  const inspected = await inspectBundle(resolved.path)
  if (inspected.entryId !== scope.entryId || inspected.recordPath !== scope.recordPath) {
    throw new Error('Dock entry identity mismatch')
  }
  const nonce = randomBytes(8).toString('hex')
  const temporary = path.join(scope.directory, `.dock-${nonce}.png`)
  const temporaryLight = path.join(scope.directory, `.dock-light-${nonce}.png`)
  const temporaryDark = path.join(scope.directory, `.dock-dark-${nonce}.png`)
  const temporaryDefault = path.join(scope.directory, `.dock-default-${nonce}.png`)
  try {
    if (inspected.customIcon) {
      await nativeOperation({ operation: 'render-file-icon', path: resolved.path, output: temporary })
      await publishDockImage(temporary, scope.iconPath)
      await Promise.all([scope.lightIconPath, scope.darkIconPath, scope.defaultIconPath]
        .map(file => rm(file, { force: true })))
    } else {
      await nativeOperation({
        operation: 'render-file-icon',
        path: resolved.path,
        output: temporaryLight,
        appearance: 'light',
      })
      await nativeOperation({
        operation: 'render-file-icon',
        path: resolved.path,
        output: temporaryDark,
        appearance: 'dark',
      })
      await nativeOperation({
        operation: 'render-file-icon',
        path: resolved.path,
        output: temporaryDefault,
        appearance: 'default',
      })
      await publishDockImage(temporaryLight, scope.lightIconPath)
      await publishDockImage(temporaryDark, scope.darkIconPath)
      await publishDockImage(temporaryDefault, scope.defaultIconPath)
      await rm(scope.iconPath, { force: true })
    }
    return true
  } finally {
    await Promise.all([temporary, temporaryLight, temporaryDark, temporaryDefault]
      .map(file => rm(file, { force: true })))
  }
}

async function publishDockImage(temporary: string, destination: string): Promise<void> {
  const file = await lstat(temporary)
  if (
    !file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()
    || file.size > 1024 * 1024
  ) throw new Error('Unsafe Dock image output')
  await chmod(temporary, 0o600)
  await rename(temporary, destination)
}

/** A stale entry must not prevent an ordinary managed Host from becoming ready. */
export async function prepareOptionalDockImage(
  scope: DockScope,
  expected: { home: string; app: string; profile: string },
): Promise<void> {
  try {
    await prepareDockImage(scope, expected)
  } catch {
    await clearDockImages(scope)
  }
}

export async function refreshDockAgent(scope: DockScope, token: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(scope.socketPath)
    const timer = setTimeout(() => socket.destroy(new Error('Dock refresh timed out')), 3_000)
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk
      if (response.length > 128) socket.destroy(new Error('Dock response too large'))
    })
    socket.once('close', () => {
      clearTimeout(timer)
      if (response === '{"ok":true}\n') resolve()
      else reject(new Error('Host Dock refresh rejected'))
    })
    socket.once(
      'connect',
      () => socket.end(JSON.stringify({ token, entryId: scope.entryId, command: 'refresh' }) + '\n'),
    )
  })
}

async function inspectorClosed(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 300)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(false)
    })
    socket.once('error', error => {
      clearTimeout(timer)
      resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED')
    })
  })
}

/** One-shot official Electron main inspector; closes before the Host becomes ready. */
export async function installDockAgent(input: {
  scope: DockScope
  token: string
  inspectorUrl: string
  hostPid: number
  hostStartedAt: string
}): Promise<() => Promise<void>> {
  const matched = /^ws:\/\/127\.0\.0\.1:(\d+)\/[a-f0-9-]+$/u.exec(input.inspectorUrl)
  if (!matched || !await hasMatchingProcessIdentity(input.hostPid, input.hostStartedAt)) {
    throw new Error('Owned Host main inspector identity mismatch')
  }
  const port = Number(matched[1])
  let session: CdpSession | undefined
  let closed = false
  const closeInspector = async (): Promise<void> => {
    if (closed) return
    if (session) {
      await session.send('Runtime.evaluate', {
        expression: "setTimeout(() => process.mainModule.require('inspector').close(), 100); true",
        returnByValue: true,
      }, 1_000).catch(() => undefined)
      session.close()
    }
    const deadline = Date.now() + 3_000
    while (!await inspectorClosed(port) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (!await inspectorClosed(port)) throw new Error('Owned Host main inspector remained open')
    closed = true
  }
  try {
    session = await CdpSession.connect(input.inspectorUrl)
    // Electron exposes the inspector before its application entry module is
    // loaded. Wait for the main module rather than racing Node bootstrap.
    const moduleDeadline = Date.now() + 10_000
    let moduleReady = false
    while (!moduleReady && Date.now() < moduleDeadline) {
      const probe = await session.send('Runtime.evaluate', {
        expression: 'Boolean(process.mainModule && typeof process.mainModule.require === "function")',
        returnByValue: true,
      }, 1_000)
      moduleReady = (probe.result as { value?: unknown })?.value === true
      if (!moduleReady) await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!moduleReady) throw new Error('Owned Host main module did not initialize')
    // All code and arguments are selected by the owning launcher. No socket
    // request can provide JavaScript, a module path, or an image path.
    const expression = `process.mainModule.require(${JSON.stringify(dockAgent)}).install(${
      JSON.stringify({
        pid: input.hostPid,
        entryId: input.scope.entryId,
        token: input.token,
        socketPath: input.scope.socketPath,
        iconPath: input.scope.iconPath,
        lightIconPath: input.scope.lightIconPath,
        darkIconPath: input.scope.darkIconPath,
        defaultIconPath: input.scope.defaultIconPath,
      })
    })`
    const response = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, 5_000)
    const remoteError = runtimeEvaluationException(response)
    if (
      remoteError
      || (response.result as { value?: { ready?: unknown; pid?: unknown } })?.value?.ready !== true
      || (response.result as { value?: { pid?: unknown } })?.value?.pid !== input.hostPid
    ) {
      throw new Error('Owned Host Dock agent initialization failed' + (remoteError ? ': ' + remoteError : ''))
    }
  } catch (error) {
    await closeInspector().catch(() => undefined)
    throw error
  }
  return closeInspector
}
