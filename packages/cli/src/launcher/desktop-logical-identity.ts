import { createHash } from 'node:crypto'

/** Read only the active native account; scope changes while awaiting it revoke admission. */
export async function desktopLogicalIdentity(input: {
  current(): Promise<boolean>
  read(): Promise<unknown>
}): Promise<string | undefined> {
  try {
    if (!await input.current()) return undefined
    const value = await input.read()
    if (typeof value !== 'string') return undefined
    const identity: unknown = JSON.parse(value)
    if (
      !Array.isArray(identity) || identity.length !== 2
      || identity.some(part =>
        typeof part !== 'string' || !part || part.length > 512 || /[\u0000-\u001f\u007f]/u.test(part)
      )
      || !await input.current()
    ) return undefined
    if (await input.read() !== value || !await input.current()) return undefined
    return 'desktop:' + createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  } catch {
    return undefined
  }
}

/** Read the native owner directly while the Desktop input queue awaits admission. */
export async function desktopLogicalDispatchIdentity(input: {
  current(): Promise<boolean>
  readNativeOwner(): Promise<string | undefined>
}): Promise<string | undefined> {
  try {
    if (!await input.current()) return undefined
    const identity = await input.readNativeOwner()
    if (!identity || !/^desktop:[a-f0-9]{64}$/u.test(identity) || !await input.current()) return undefined
    return identity
  } catch {
    return undefined
  }
}
