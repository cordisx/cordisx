import { createMacOSKeychainBackend, type LauncherKeychainBackend, LauncherKeychainError } from './secret-store.js'
const ENV_SECRET = /^host-secret:env\/([A-Za-z_][A-Za-z0-9_]{0,127})$/
const KEYCHAIN_SECRET = /^keychain:([A-Za-z0-9][A-Za-z0-9._:/-]{0,500})$/

/** A bounded error that deliberately never includes the secret reference or value. */
export class LauncherSecretResolutionError extends Error {
  constructor(readonly code: 'SECRET_MISSING' | 'SECRET_UNAVAILABLE' | 'SECRET_REF_INVALID') {
    super(code)
    this.name = `CHANNEL_${code}`
  }
}

export interface LauncherSecretResolverOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** Test seam for legacy consumers; prefer `keychainBackend` for all operations. */
  readonly readKeychain?: (service: string, account: string) => Promise<string>
  readonly keychainBackend?: Pick<LauncherKeychainBackend, 'read'>
}

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 && !/[\r\n\u0000]/u.test(value)
}

/**
 * Resolves the two protocol-approved launcher-private secret reference kinds.
 * The result is intentionally ephemeral: callers must not persist, log, or
 * project it to the renderer.
 */
export async function resolveLauncherSecret(
  reference: string | undefined,
  options: LauncherSecretResolverOptions = {},
): Promise<string> {
  if (reference === undefined) throw new LauncherSecretResolutionError('SECRET_MISSING')
  const env = ENV_SECRET.exec(reference)
  if (env !== null) {
    const value = (options.environment ?? process.env)[env[1]!]
    if (!validValue(value)) throw new LauncherSecretResolutionError('SECRET_MISSING')
    return value
  }
  const keychain = KEYCHAIN_SECRET.exec(reference)
  if (keychain === null) throw new LauncherSecretResolutionError('SECRET_REF_INVALID')
  if ((options.platform ?? process.platform) !== 'darwin') throw new LauncherSecretResolutionError('SECRET_UNAVAILABLE')
  const segments = keychain[1]!.split('/')
  if (segments.length < 2) throw new LauncherSecretResolutionError('SECRET_REF_INVALID')
  const account = segments.pop()!
  const service = segments.join('/')
  let value: string
  try {
    value = options.readKeychain !== undefined
      ? await options.readKeychain(service, account)
      : options.keychainBackend !== undefined
      ? await options.keychainBackend.read(service, account)
      : await createMacOSKeychainBackend().read(service, account)
  } catch (error) {
    if (error instanceof LauncherKeychainError && error.code === 'UNAVAILABLE') {
      throw new LauncherSecretResolutionError('SECRET_UNAVAILABLE')
    }
    throw new LauncherSecretResolutionError('SECRET_MISSING')
  }
  if (!validValue(value)) throw new LauncherSecretResolutionError('SECRET_MISSING')
  return value
}
