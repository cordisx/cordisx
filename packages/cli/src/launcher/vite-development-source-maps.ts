import { createHash } from 'node:crypto'

const DEFAULT_MAX_ENTRIES = 256
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024

export interface NativeViteSourceMapStoreOptions {
  readonly maxEntries?: number
  readonly maxBytes?: number
  readonly maxEntryBytes?: number
}

export class NativeViteSourceMapStore {
  readonly #entries = new Map<string, { readonly contents: string; readonly bytes: number }>()
  readonly #maxEntries: number
  readonly #maxBytes: number
  readonly #maxEntryBytes: number
  #bytes = 0

  constructor(options: NativeViteSourceMapStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.#maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES
  }

  get(pathname: string): string | undefined {
    return this.#entries.get(pathname)?.contents
  }

  remember(base: string, encoded: string): string | undefined {
    const decodedBytes = Buffer.byteLength(encoded, 'base64')
    if (decodedBytes > this.#maxEntryBytes || decodedBytes > this.#maxBytes) return undefined
    const contents = Buffer.from(encoded, 'base64').toString('utf8')
    const bytes = Buffer.byteLength(contents)
    const mapPath = base + 'maps/' + createHash('sha256').update(contents).digest('hex') + '.map'
    const previous = this.#entries.get(mapPath)
    if (previous !== undefined) {
      this.#entries.delete(mapPath)
      this.#bytes -= previous.bytes
    }
    this.#entries.set(mapPath, { contents, bytes })
    this.#bytes += bytes
    while (this.#entries.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      const removed = this.#entries.get(oldest)!
      this.#entries.delete(oldest)
      this.#bytes -= removed.bytes
    }
    return this.#entries.has(mapPath) ? mapPath : undefined
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }
}
