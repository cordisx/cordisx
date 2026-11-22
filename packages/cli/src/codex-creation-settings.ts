/** Host-private model defaults; the public execution-settings contract remains separate. */
export interface CodexCreationSettings {
  readonly providerId?: string
  readonly model?: string
  readonly fast?: boolean
}
export interface CodexCreationDefaults {
  readonly revision: number
  readonly settings: CodexCreationSettings
}
export function parseCodexCreationSettings(value: unknown): CodexCreationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CREATION_SETTINGS')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['providerId', 'model', 'fast'].includes(key))) {
    throw new Error('INVALID_CREATION_SETTINGS')
  }
  for (const [key, maximum] of [['providerId', 128], ['model', 512]] as const) {
    if (
      row[key] !== undefined && (typeof row[key] !== 'string' || !row[key] || row[key].length > maximum
        || /[\0\r\n]/u.test(row[key]))
    ) throw new Error('INVALID_CREATION_SETTINGS')
  }
  if (row.fast !== undefined && typeof row.fast !== 'boolean') throw new Error('INVALID_CREATION_SETTINGS')
  return { ...row } as CodexCreationSettings
}
export function parseCodexCreationDefaults(value: unknown): CodexCreationDefaults | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CREATION_DEFAULTS')
  const row = value as Record<string, unknown>
  if (
    Object.keys(row).some(key => !['revision', 'settings'].includes(key)) || !Number.isSafeInteger(row.revision)
    || Number(row.revision) < 0
  ) throw new Error('INVALID_CREATION_DEFAULTS')
  return { revision: Number(row.revision), settings: parseCodexCreationSettings(row.settings) }
}
