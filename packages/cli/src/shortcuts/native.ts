import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const shortcutHelper = fileURLToPath(
  new URL(
    import.meta.url.includes('/dist/') ? '../../native/CordisXEntry' : '../../dist/native/CordisXEntry',
    import.meta.url,
  ),
)
export async function requireShortcutHelper(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('System shortcuts currently support macOS only')
  await access(shortcutHelper, constants.X_OK).catch(() => {
    throw new Error('This CordisX build has no macOS shortcut helper; build the native helper first')
  })
}
export async function nativeOperation<T>(request: Record<string, unknown>): Promise<T> {
  await requireShortcutHelper()
  return await new Promise<T>((resolve, reject) => {
    const child = spawn(shortcutHelper, ['--tool'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Shortcut helper timed out'))
    }, 15_000)
    child.stdout.on('data', chunk => {
      output += String(chunk)
      if (Buffer.byteLength(output) > 128 * 1024) child.kill()
    })
    child.stderr.on('data', chunk => {
      error = (error + String(chunk)).slice(-4096)
    })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      try {
        const result = JSON.parse(output) as T & { error?: string }
        if (code !== 0 || result.error) throw new Error(result.error ?? (error || 'Shortcut helper failed'))
        resolve(result)
      } catch (reason) {
        reject(reason)
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request))
  })
}
export interface BundleInspection {
  path: string
  customIcon: boolean
  bookmark: string
  entryId: string
  recordPath: string
}
export async function inspectBundle(path: string): Promise<BundleInspection> {
  return nativeOperation({ operation: 'inspect', path })
}
