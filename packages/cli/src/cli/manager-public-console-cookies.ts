import { randomBytes, timingSafeEqual } from 'node:crypto'

interface Cookie {
  readonly name: string
  readonly pair: string
  readonly value: string
  readonly expiresAt: number
}

function validName(value: string): boolean {
  return value.length > 0 && value.length <= 128
    && [...value].every(char => /^[!#$%&'*+.^_|~0-9A-Za-z-]$/u.test(char) || char.charCodeAt(0) === 96)
}

function validValue(value: string): boolean {
  return [...value].every(char => {
    const code = char.charCodeAt(0)
    return code === 0x21 || code >= 0x23 && code <= 0x2b || code >= 0x2d && code <= 0x3a
      || code >= 0x3c && code <= 0x5b || code >= 0x5d && code <= 0x7e
  })
}

function parsed(header: string): Cookie | undefined {
  if (header.length > 4_096) return undefined
  const [pair, ...fields] = header.split(';').map(value => value.trim())
  const equal = pair!.indexOf('=')
  const name = pair!.slice(0, equal)
  const value = pair!.slice(equal + 1)
  if (equal < 1 || !validName(name) || !validValue(value)) return undefined
  const attributes = new Map<string, string>()
  for (const field of fields) {
    const [key, ...parts] = field.split('=')
    const lower = key!.trim().toLowerCase()
    if (attributes.has(lower)) return undefined
    attributes.set(lower, parts.join('=').trim())
  }
  if (
    attributes.get('path') !== '/' || attributes.get('samesite')?.toLowerCase() !== 'none'
    || !['secure', 'httponly', 'partitioned'].every(key => attributes.get(key) === '') || attributes.has('domain')
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
  return { name, pair: pair!, value, expiresAt }
}

/**
 * Keep service cookies in the ingress. The browser receives only a separate,
 * origin-scoped HTTP authentication credential.
 */
export class ManagerPublicConsoleCookies {
  private credential: Buffer | undefined
  private primary: string | undefined
  private readonly cookies = new Map<string, Cookie>()

  begin(headers: readonly string[]): string | undefined {
    const cookie = headers.length === 1 ? parsed(headers[0]!) : undefined
    if (
      !cookie || cookie.expiresAt <= Date.now() || !/^__Host-[A-Za-z0-9_-]{1,80}$/u.test(cookie.name)
      || !/^[A-Za-z0-9_-]{24,128}$/u.test(cookie.value)
    ) return undefined
    this.clear()
    const password = randomBytes(32).toString('base64url')
    this.credential = Buffer.from('Basic ' + Buffer.from('cx:' + password).toString('base64'))
    this.primary = cookie.name
    this.cookies.set(cookie.name, cookie)
    return password
  }

  incoming(authorization: string | undefined): string | undefined {
    const expected = this.credential
    const presented = typeof authorization === 'string' ? Buffer.from(authorization) : undefined
    if (!expected || !presented || expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      return undefined
    }
    const primary = this.primary && this.cookies.get(this.primary)
    if (!primary || primary.expiresAt <= Date.now()) {
      this.clear()
      return undefined
    }
    const values = [primary.pair]
    let bytes = primary.pair.length
    for (const [name, cookie] of this.cookies) {
      if (name === primary.name) continue
      if (cookie.expiresAt <= Date.now()) {
        this.cookies.delete(name)
      } else if (bytes + cookie.pair.length + 2 <= 8_192) {
        values.push(cookie.pair)
        bytes += cookie.pair.length + 2
      }
    }
    return values.join('; ')
  }

  update(authorization: string | undefined, headers: readonly string[]): void {
    if (!this.incoming(authorization)) return
    for (const header of headers) {
      const cookie = parsed(header)
      if (!cookie) continue
      if (cookie.name === this.primary) {
        if (cookie.expiresAt <= Date.now()) this.clear()
      } else if (cookie.expiresAt <= Date.now()) {
        this.cookies.delete(cookie.name)
      } else if (this.cookies.has(cookie.name) || this.cookies.size < 17) {
        this.cookies.set(cookie.name, cookie)
      }
    }
  }

  clear(): void {
    this.credential?.fill(0)
    this.credential = undefined
    this.primary = undefined
    this.cookies.clear()
  }
}
