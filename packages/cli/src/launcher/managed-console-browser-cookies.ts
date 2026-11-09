import { createHash } from 'node:crypto'

interface CookieBinding {
  readonly name: string
  readonly digest: string
  readonly expiresAt: number
}

interface ParsedCookie {
  readonly name: string
  readonly pair: string
  readonly value: string
  readonly clearing: boolean
  readonly expiresAt: number
}

const MAX_SUPPORTING_COOKIES = 16
const MAX_COOKIE_HEADER_BYTES = 8_192

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function parseCookie(header: string): ParsedCookie | undefined {
  if (header.length > 4_096) return undefined
  const [pair, ...fields] = header.split(';').map(field => field.trim())
  const equal = pair!.indexOf('=')
  if (equal < 1) return undefined
  const name = pair!.slice(0, equal)
  const value = pair!.slice(equal + 1)
  if (
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/u.test(name)
    || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]{0,3800}$/u.test(value)
  ) return undefined
  const attributes = new Map<string, string>()
  for (const field of fields) {
    const [key, ...parts] = field.split('=')
    const lower = key!.trim().toLowerCase()
    if (attributes.has(lower)) return undefined
    attributes.set(lower, parts.join('=').trim())
  }
  if (
    attributes.get('path') !== '/' || attributes.get('samesite')?.toLowerCase() !== 'none'
    || !['secure', 'httponly', 'partitioned'].every(key => attributes.get(key) === '')
    || attributes.has('domain')
  ) return undefined
  const age = attributes.get('max-age')
  if (age !== undefined && !/^(?:0|[1-9][0-9]{0,7})$/u.test(age)) return undefined
  const expires = attributes.get('expires')
  if (age === undefined && expires !== undefined && !Number.isFinite(Date.parse(expires))) return undefined
  const expiresAt = age !== undefined
    ? Date.now() + Number(age) * 1_000
    : expires !== undefined
    ? Date.parse(expires)
    : Infinity
  return { name, pair: pair!, value, clearing: expiresAt <= Date.now(), expiresAt }
}

/** Only this route's verified service can issue cookies. Store digests, never credential values. */
export class ManagedConsoleBrowserCookies {
  private session: CookieBinding | undefined
  private readonly supporting = new Map<string, CookieBinding>()

  clear() {
    this.session = undefined
    this.supporting.clear()
  }

  forwarded(header: string | undefined): string | undefined {
    const session = this.session
    if (!header || !session || session.expiresAt <= Date.now()) return undefined
    const pairs = header.split(';').map(pair => pair.trim())
    const matching = (binding: CookieBinding) => {
      const named = pairs.filter(pair => pair.startsWith(binding.name + '='))
      return named.length === 1 && digest(named[0]!) === binding.digest ? named[0] : undefined
    }
    const primary = matching(session)
    // Pending authorization state cannot authenticate a request on its own.
    if (!primary) return undefined
    const allowed = [primary]
    let bytes = primary.length
    for (const [name, binding] of this.supporting) {
      if (binding.expiresAt <= Date.now()) {
        this.supporting.delete(name)
        continue
      }
      const pair = matching(binding)
      if (pair && bytes + pair.length + 2 <= MAX_COOKIE_HEADER_BYTES) {
        allowed.push(pair)
        bytes += pair.length + 2
      }
    }
    return allowed.join('; ')
  }

  accept(headers: readonly string[], redeeming: boolean, authenticated: boolean): string[] {
    if (redeeming) {
      const cookie = headers.length === 1 ? parseCookie(headers[0]!) : undefined
      if (
        !cookie || cookie.clearing || this.session
        || !/^__Host-[A-Za-z0-9_-]{1,80}$/u.test(cookie.name)
        || !/^[A-Za-z0-9_-]{24,128}$/u.test(cookie.value)
      ) throw new Error('Managed console redemption returned invalid cookie material')
      this.session = { name: cookie.name, digest: digest(cookie.pair), expiresAt: cookie.expiresAt }
      return [...headers]
    }
    const session = this.session
    if (!session || !authenticated) return []
    const parsed = headers.map(header => ({ header, cookie: parseCookie(header) }))
    const logout = parsed.find(({ cookie }) => cookie?.name === session.name && cookie.clearing)
    if (logout) {
      this.clear()
      return [logout.header]
    }
    const accepted: string[] = []
    for (const { header, cookie } of parsed) {
      if (!cookie || cookie.name === session.name) continue
      // Both normal and CHIPS variants may be issued. Only the origin-bound,
      // HttpOnly partitioned variant crosses this gateway; ordinary cookies do not.
      if (cookie.clearing) {
        if (this.supporting.delete(cookie.name)) accepted.push(header)
      } else if (
        cookie.expiresAt !== Infinity
        && (this.supporting.has(cookie.name) || this.supporting.size < MAX_SUPPORTING_COOKIES)
      ) {
        this.supporting.set(cookie.name, {
          name: cookie.name,
          digest: digest(cookie.pair),
          expiresAt: Math.min(cookie.expiresAt, session.expiresAt),
        })
        accepted.push(header)
      }
    }
    return accepted
  }
}
