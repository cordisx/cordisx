import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { isManagerBrowserOrigin } from '../independent-manager/manager-browser-origin.js'

type ManagerWeb = {
  readonly origin: string
  issueUrl(retire?: () => Promise<void>): string
  revokeUrl(url: string): Promise<void>
}

async function privateDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new Error('MANAGER_PRIVATE_ENTRY_UNSUPPORTED')
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const state = await lstat(directory)
  if (!state.isDirectory() || state.uid !== process.getuid()) throw new Error('MANAGER_PRIVATE_ENTRY_UNAVAILABLE')
  await chmod(directory, 0o700)
}

/** Only manager-owned, random entry files in this private directory are recovered. */
export async function recoverManagerEntries(directory: string): Promise<void> {
  await privateDirectory(directory)
  for (const name of await readdir(directory)) {
    if (/^[a-f0-9]{32}\.html$/u.test(name)) await rm(path.join(directory, name), { force: true })
  }
}

/** Openers receive this private filename, never a browser bearer or bootstrap in argv. */
export async function createManagerEntry(directory: string, web: ManagerWeb): Promise<string> {
  await privateDirectory(directory)
  const file = path.join(directory, `${randomBytes(16).toString('hex')}.html`)
  const clean = async () => {
    await rm(file, { force: true })
  }
  const url = web.issueUrl(clean)
  let valid = false
  try {
    const entry = new URL(url)
    valid = isManagerBrowserOrigin(web.origin) && entry.origin === web.origin && entry.pathname === '/'
      && entry.search === ''
      && !entry.username && !entry.password && /^#[a-f0-9]{64}$/u.test(entry.hash)
  } catch { /* An invalid URL cannot be opened. */ }
  if (!valid) {
    await web.revokeUrl(url)
    throw new Error('MANAGER_ENTRY_URL_INVALID')
  }
  try {
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== process.getuid!()) throw new Error('MANAGER_PRIVATE_ENTRY_UNAVAILABLE')
      await handle.chmod(0o600)
      await handle.writeFile(
        `<!doctype html><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'"><title>Opening CordisX</title><script>location.replace(${
          JSON.stringify(url)
        })</script>`,
      )
    } finally {
      await handle.close()
    }
    return file
  } catch (error) {
    await web.revokeUrl(url).catch(() => undefined)
    await clean().catch(() => undefined)
    throw error
  }
}

export async function validateManagerEntry(file: string, directory: string): Promise<boolean> {
  if (path.dirname(file) !== directory || !/^[a-f0-9]{32}\.html$/u.test(path.basename(file))) return false
  const metadata = await lstat(file).catch(() => undefined)
  return metadata?.isFile() === true && typeof process.getuid === 'function' && metadata.uid === process.getuid()
    && (metadata.mode & 0o077) === 0
}
