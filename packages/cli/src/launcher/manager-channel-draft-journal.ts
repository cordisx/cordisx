import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { withLockedExistingHomeConfig } from '../config/home-config.js'
import type { LauncherSecretStore } from './secret-store.js'

const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const DRAFT = /^draft-[a-f0-9]{40}$/u
const MAX_RECORDS = 256

function contains(value: unknown, reference: string): boolean {
  if (typeof value === 'string') return value.includes(reference)
  if (Array.isArray(value)) return value.some(item => contains(item, reference))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => key.includes(reference) || contains(item, reference))
  }
  return false
}

/** A value-free write-ahead record for manager-created drafts only. */
export class ManagerChannelDraftJournal {
  private readonly directory: string
  constructor(
    private readonly input: {
      readonly homeDir: string
      readonly configPath: string
      readonly profileId: string
      readonly store: LauncherSecretStore
    },
  ) {
    if (!path.isAbsolute(input.homeDir) || !path.isAbsolute(input.configPath) || !PROFILE.test(input.profileId)) {
      throw new Error('DRAFT_JOURNAL_UNAVAILABLE')
    }
    this.directory = path.join(input.homeDir, 'credentials', 'manager-channel-drafts', input.profileId)
  }

  private assertPrivate(info: Stats, directory: boolean): void {
    if (
      (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== (directory ? 0o700 : 0o600)
    ) {
      throw new Error('DRAFT_JOURNAL_UNAVAILABLE')
    }
  }

  private async prepare(): Promise<void> {
    for (
      const directory of [path.join(this.input.homeDir, 'credentials'), path.dirname(this.directory), this.directory]
    ) {
      let created = false
      await mkdir(directory, { mode: 0o700 }).then(() => {
        created = true
      }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      this.assertPrivate(await lstat(directory), true)
      if (created) {
        const parent = await open(path.dirname(directory), constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          await parent.sync()
        } finally {
          await parent.close()
        }
      }
    }
  }

  private id(reference: string): string {
    const prefixes = [
      `keychain:cordisx/channel/${this.input.profileId}/`,
      `host-secret:channel/${this.input.profileId}/`,
    ]
    const prefix = prefixes.find(value => reference.startsWith(value))
    const id = prefix === undefined ? '' : reference.slice(prefix.length)
    if (!DRAFT.test(id)) throw new Error('DRAFT_JOURNAL_UNAVAILABLE')
    return id
  }

  async record(reference: string): Promise<void> {
    const id = this.id(reference)
    await this.prepare()
    const file = path.join(this.directory, `${id}.json`)
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.writeFile(JSON.stringify({ version: 1, profileId: this.input.profileId, reference }))
      await handle.sync()
    } finally {
      await handle.close()
    }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  async retire(reference: string): Promise<void> {
    const id = this.id(reference)
    await this.prepare()
    await unlink(path.join(this.directory, `${id}.json`)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  /** A rejected mutation can still have committed before finalization failed. */
  async cleanup(reference: string): Promise<boolean> {
    this.id(reference)
    return await withLockedExistingHomeConfig(this.input.configPath, async config => {
      if (contains(config, reference)) return true
      return await this.input.store.removeManagerDraftReference(reference, this.input.profileId)
    })
  }

  /** Preserve unknown records and every active, last-good or candidate reference. */
  async recover(): Promise<void> {
    await this.prepare()
    const names = await readdir(this.directory)
    if (names.length > MAX_RECORDS) throw new Error('DRAFT_RECOVERY_UNAVAILABLE')
    for (const name of names) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (!DRAFT.test(id)) throw new Error('DRAFT_RECOVERY_UNAVAILABLE')
      const file = path.join(this.directory, name)
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      let entry: unknown
      try {
        const info = await handle.stat()
        this.assertPrivate(info, false)
        if (info.size > 4_096) throw new Error('DRAFT_RECOVERY_UNAVAILABLE')
        entry = JSON.parse(await handle.readFile('utf8')) as unknown
      } finally {
        await handle.close()
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('DRAFT_RECOVERY_UNAVAILABLE')
      const record = entry as Record<string, unknown>
      if (
        Object.keys(record).some(key => !['version', 'profileId', 'reference'].includes(key))
        || record.version !== 1 || record.profileId !== this.input.profileId || typeof record.reference !== 'string'
        || this.id(record.reference) !== id
      ) throw new Error('DRAFT_RECOVERY_UNAVAILABLE')
      const reference = record.reference
      const resolved = await this.cleanup(reference)
      if (!resolved) throw new Error('DRAFT_RECOVERY_UNAVAILABLE')
      await this.retire(reference)
    }
  }
}
