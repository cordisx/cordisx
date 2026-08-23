import { describe, expect, it } from 'vitest'
import {
  isPublicMarketplaceAddress,
  normalizeMarketplaceRequestUrl,
} from '../packages/cli/src/launcher/marketplace.js'

describe('launcher marketplace network boundary', () => {
  it('accepts public HTTPS feed URLs without credentials or fragments', () => {
    expect(normalizeMarketplaceRequestUrl('https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json').href)
      .toBe('https://raw.githubusercontent.com/cordisx/marketplace/main/marketplace.json')
    expect(() => normalizeMarketplaceRequestUrl('http://example.com/feed.json')).toThrow('HTTPS URL')
    expect(() => normalizeMarketplaceRequestUrl('https://user@example.com/feed.json')).toThrow('credentials')
    expect(() => normalizeMarketplaceRequestUrl('https://example.com/feed.json#entry')).toThrow('fragment')
  })

  it('rejects non-public IPv4 and IPv6 destinations', () => {
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.168.1.1',
      '198.18.0.1',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      'ff02::1',
    ]) expect(isPublicMarketplaceAddress(address), address).toBe(false)
    expect(isPublicMarketplaceAddress('1.1.1.1')).toBe(true)
    expect(isPublicMarketplaceAddress('2606:4700:4700::1111')).toBe(true)
  })
})
