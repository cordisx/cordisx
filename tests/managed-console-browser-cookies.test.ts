import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedConsoleBrowserCookies } from '../packages/cli/src/launcher/managed-console-browser-cookies.js'

const primary = '__Host-console=' + 'a'.repeat(32)
const attributes = '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=900'
const pending = 'device_pending_embedded=' + 'b'.repeat(210) + '.' + 'c'.repeat(43)

function authenticated() {
  const cookies = new ManagedConsoleBrowserCookies()
  cookies.accept([primary + attributes], true, false)
  return cookies
}

afterEach(() => vi.useRealTimers())

describe('managed browser cookie trust boundary', () => {
  it('requires the bound session and rejects unissued, tampered and ambiguous cookie pairs', () => {
    const cookies = authenticated()
    expect(cookies.accept([pending + attributes], false, false)).toEqual([])
    expect(cookies.forwarded(primary + '; ' + pending)).toBe(primary)
    cookies.accept([pending + attributes], false, true)
    expect(cookies.forwarded(pending)).toBeUndefined()
    expect(cookies.forwarded(primary + 'x; ' + pending)).toBeUndefined()
    expect(cookies.forwarded(primary + '; ' + primary + '; ' + pending)).toBeUndefined()
    expect(cookies.forwarded(primary + '; parent=secret; ' + pending + 'x')).toBe(primary)
    expect(cookies.forwarded(primary + '; ' + pending + '; ' + pending)).toBe(primary)
    expect(cookies.forwarded(primary + '; parent=secret; ' + pending)).toBe(primary + '; ' + pending)
  })

  it.each([
    '; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600',
    '; Path=/; HttpOnly; SameSite=None; Partitioned; Max-Age=600',
    '; Path=/; Secure; SameSite=None; Partitioned; Max-Age=600',
    '; Path=/; Secure; HttpOnly; SameSite=Lax; Partitioned; Max-Age=600',
    '; Path=/elsewhere; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=600',
    attributes + '; Domain=localhost',
    attributes + '; Path=/',
    '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned',
    attributes.replace('900', '-1'),
  ])('does not admit a supporting cookie outside the partition and expiry policy: %s', invalid => {
    const cookies = authenticated()
    expect(cookies.accept([pending + invalid], false, true)).toEqual([])
    expect(cookies.forwarded(primary + '; ' + pending)).toBe(primary)
  })

  it('replaces a service-issued cookie exactly and clears every supporting binding on logout', () => {
    const cookies = authenticated()
    cookies.accept([pending + attributes], false, true)
    const replacement = pending + 'new'
    cookies.accept([replacement + attributes], false, true)
    expect(cookies.forwarded(primary + '; ' + pending)).toBe(primary)
    expect(cookies.forwarded(primary + '; ' + replacement)).toBe(primary + '; ' + replacement)
    const clear = 'device_pending_embedded=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0'
    expect(cookies.accept([clear], false, true)).toEqual([clear])
    expect(cookies.forwarded(primary + '; ' + replacement)).toBe(primary)
    cookies.accept([pending + attributes], false, true)
    const logout = '__Host-console=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0'
    expect(cookies.accept([pending + attributes, logout], false, true)).toEqual([logout])
    expect(cookies.forwarded(primary + '; ' + pending)).toBeUndefined()
  })

  it('bounds cookie lifetime by the route session and removes expired authorization state', () => {
    vi.useFakeTimers()
    const cookies = authenticated()
    cookies.accept([pending + attributes.replace('900', '2')], false, true)
    vi.advanceTimersByTime(2_001)
    expect(cookies.forwarded(primary + '; ' + pending)).toBe(primary)
    cookies.accept([pending + attributes.replace('900', '3600')], false, true)
    vi.advanceTimersByTime(900_000)
    expect(cookies.forwarded(primary + '; ' + pending)).toBeUndefined()
  })

  it('bounds supporting names and forwarded header size without retaining credential values', () => {
    const cookies = authenticated()
    for (let i = 0; i < 16; ++i) cookies.accept(['cookie_' + i + '=value' + attributes], false, true)
    expect(cookies.accept(['extra=value' + attributes], false, true)).toEqual([])
    cookies.clear()
    cookies.accept([primary + attributes], true, false)
    const pairs = [primary]
    for (let i = 0; i < 3; ++i) {
      const pair = 'cookie_' + i + '=' + 'd'.repeat(3_700)
      cookies.accept([pair + attributes], false, true)
      pairs.push(pair)
    }
    const forwarded = cookies.forwarded(pairs.join('; '))!
    expect(forwarded.length).toBeLessThanOrEqual(8_192)
    expect(forwarded.split('; ')).toHaveLength(3)
    expect(JSON.stringify(cookies)).not.toContain('d'.repeat(24))
  })
})
