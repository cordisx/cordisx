import { CURRENT_USER_NATIVE_PINS } from '../../current-user-native-pins.js'
import { readPinnedNativeAccount } from '../../current-user-native-account.js'
import { canonicalAvatar } from './bitmap.js'
export type CurrentUserSource = {
  readonly status: 'available'
  /** Native identity stays Host-private and is never returned through the public API. */
  readonly identity: string
  readonly displayName?: string
  readonly avatar?: string
} | { readonly status: 'unavailable'; readonly reason: 'signed-out' | 'host-unavailable' }
export const CURRENT_USER_NATIVE_PIN = CURRENT_USER_NATIVE_PINS[0]
interface NativeModuleTyped {
  readonly TW: { readonly accessInputs: { readAccountInfo(): Promise<unknown> } }
  readonly mJt: { getInstance(): NativeClient }
  readonly Uqt: { safeGet(path: string, options: { signal: AbortSignal }): Promise<unknown> }
  readonly Gqt: () => Record<string, string>
}
interface NativeClient {
  post(url: string, body?: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<{ body: unknown }>
  fetch(url: string, options: { headers?: Record<string, string>; signal: AbortSignal }): Promise<Response>
}
interface NativeModule {
  readonly gJt: { getInstance(): NativeClient }
  readonly eSt: (signal: AbortSignal) => Promise<unknown>
  readonly jKt: { safeGet(path: string, options: { signal: AbortSignal }): Promise<unknown> }
  /** Native request control flags, never access/refresh tokens. */
  readonly NKt: () => Record<string, string>
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function identity(value: unknown): string | undefined {
  const info = object(value)
  return typeof info.accountId === 'string' && info.accountId && typeof info.userId === 'string' && info.userId
    ? JSON.stringify([info.accountId, info.userId])
    : undefined
}
/** Authentication control flags are allowed only for the native profile image routes. */
export function avatarRequest(value: unknown): { url: string; authenticated: boolean } | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined
    const authenticated = url.hostname === 'chatgpt.com'
      && ['/backend-api/estuary/content', '/backend-api/estuary/public_content/enc']
        .some(path => url.pathname === path || url.pathname.startsWith(`${path}/`))
    const publicImage = [
      'cdn.oaistatic.com',
      'images.openai.com',
      'lh3.googleusercontent.com',
      'files.oaiusercontent.com',
    ]
      .includes(url.hostname)
    return authenticated || publicImage ? { url: url.href, authenticated } : undefined
  } catch {
    return undefined
  }
}
/** Exact audited native display-profile client; no DOM, credential getter, login or Agent provider. */
export async function readNativeCurrentUser(
  signal: AbortSignal,
  load: (path: string) => Promise<NativeModule | NativeModuleTyped> = path => import(/* @vite-ignore */ path),
): Promise<CurrentUserSource> {
  const page = globalThis as typeof globalThis & {
    electronBridge?: { getSentryInitOptions?: () => unknown }
    codexWindowType?: string
  }
  const unavailable = { status: 'unavailable', reason: 'host-unavailable' } as const
  if (page.codexWindowType !== 'electron' || page.location?.href !== 'app://-/index.html') return unavailable
  try {
    const pin = object(await page.electronBridge?.getSentryInitOptions?.())
    const adapter = CURRENT_USER_NATIVE_PINS.find(candidate =>
      pin.appVersion === candidate.appVersion && pin.buildNumber === candidate.buildNumber
      && pin.buildFlavor === candidate.buildFlavor
    )
    if (!adapter) return unavailable
    const module = await load(adapter.module)
    // Audited builds 8881 and 9275 share the typed account/profile exports.
    // Their own Codex profile client supplies name/picture directly; the
    // old /me export is absent. Never reuse old symbol names on a new bundle.
    const native: NativeModule = adapter === CURRENT_USER_NATIVE_PIN ? module as NativeModule : {
      gJt: (module as NativeModuleTyped).mJt,
      eSt: async () => undefined,
      jKt: (module as NativeModuleTyped).Uqt,
      NKt: (module as NativeModuleTyped).Gqt,
    }
    if (!native.gJt?.getInstance || !native.eSt || !native.jKt?.safeGet || !native.NKt) return unavailable
    const client = native.gJt.getInstance()
    const account = () =>
      readPinnedNativeAccount(adapter === CURRENT_USER_NATIVE_PIN ? 'legacy-post' : 'typed', module, signal)
    const before = identity(await account())
    if (!before) return { status: 'unavailable', reason: 'signed-out' }
    const [meValue, codexValue] = await Promise.all([
      native.eSt(signal).catch(() => undefined),
      native.jKt.safeGet('/wham/profiles/me', { signal }).catch(() => undefined),
    ])
    const me = object(meValue), profile = object(object(codexValue).profile)
    const displayName = [profile.display_name, me.name].find(value => typeof value === 'string' && value.trim()) as
      | string
      | undefined
    const request = avatarRequest(profile.profile_picture_url ?? me.picture ?? me.profile_picture_url)
    let avatar: string | undefined
    if (request) {
      try {
        avatar = await canonicalAvatar(
          await client.fetch(request.url, {
            headers: request.authenticated ? native.NKt() : {},
            signal,
          }),
          signal,
        )
      } catch { /* Missing or undecodable images use the consumer's normal fallback. */ }
    }
    signal.throwIfAborted()
    if (identity(await account()) !== before) return unavailable
    return {
      status: 'available',
      identity: before,
      ...(displayName ? { displayName } : {}),
      ...(avatar ? { avatar } : {}),
    }
  } catch {
    return unavailable
  }
}
