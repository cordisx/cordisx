import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeAccountCapability } from '../packages/cli/src/native-account-capability.js'
import { nativeAccountResource } from './fixtures/native-account-resource.js'
import {
  discoverNativeAccountCapability,
  discoverNativeAccountCapabilityFromSyntax,
} from '../packages/cli/src/launcher/native-account-structure.js'
import { parseNativeSource } from '../packages/cli/src/launcher/native-source-structure.js'

afterEach(() => vi.unstubAllGlobals())
function environment(names = ['app://-/assets/app-initial-future.js']) {
  vi.stubGlobal('location', { href: 'app://-/index.html' })
  vi.stubGlobal('document', nativeAccountResource.document)
  vi.stubGlobal('performance', { getEntriesByType: () => names.map(name => ({ name })) })
}
describe('native account structural capability', () => {
  it('follows a query-owned named import to the local shared service export', async () => {
    const query = {
      url: 'app://-/assets/app-initial-future.js',
      source:
        'import { Service as services } from "./app-shared-future.js";async function read(){let info=services?.accountInfo;return info.readAccountInfo()}',
    }
    const service = { url: 'app://-/assets/app-shared-future.js', source: 'let native;export {native as Service};' }
    const descriptor = discoverNativeAccountCapabilityFromSyntax(query, parseNativeSource(query.source), [
      query,
      service,
    ])
    expect(descriptor).toEqual({ module: service.url, exportName: 'Service', readerProperty: 'accountInfo' })
    expect(() => discoverNativeAccountCapabilityFromSyntax(query, parseNativeSource(query.source), [query])).toThrow()
    expect(() =>
      discoverNativeAccountCapabilityFromSyntax(query, parseNativeSource(query.source), [query, {
        ...service,
        source: 'export {}',
      }])
    ).toThrow()
    environment([query.url, service.url])
    const readAccountInfo = vi.fn()
    const load = vi.fn(async () => ({ Service: { accountInfo: { readAccountInfo } } }))
    const result = await nativeAccountCapability(load, descriptor)
    expect(load).toHaveBeenCalledWith(service.url)
    expect(result.native.TW.accessInputs.readAccountInfo).toBe(readAccountInfo)
    expect(readAccountInfo).not.toHaveBeenCalled()
    await expect(
      nativeAccountCapability(load, {
        ...descriptor,
        module: 'https://foreign.example.test/assets/app-shared-future.js',
      }),
    ).rejects.toThrow('invalid resource')
  })
  it('discovers the split account reader independently of the access-input subscription', async () => {
    const resource = {
      url: 'app://-/assets/app-initial-future.js',
      source:
        'let services;function subscribe(){let input=services?.accessInputs;input.subscribe()}async function read(){let account=services?.accountInfo;return account.readAccountInfo()}export {services as Renamed};',
    }
    const descriptor = discoverNativeAccountCapability(resource)
    expect(descriptor).toEqual({ module: resource.url, exportName: 'Renamed', readerProperty: 'accountInfo' })
    environment()
    const readAccountInfo = vi.fn()
    const subscription = vi.fn()
    const result = await nativeAccountCapability(
      async () => ({ Renamed: { accountInfo: { readAccountInfo }, accessInputs: { subscribe: subscription } } }),
      descriptor,
    )
    expect(result.native.TW.accessInputs.readAccountInfo).toBe(readAccountInfo)
    expect(readAccountInfo).not.toHaveBeenCalled()
    expect(subscription).not.toHaveBeenCalled()
  })
  it('rejects ambiguous split readers and missing descriptor-selected readers', async () => {
    const resource = {
      url: 'app://-/assets/app-initial-future.js',
      source:
        'let services;function old(){let a=services.accessInputs;return a.readAccountInfo()}function next(){let b=services.accountInfo;return b.readAccountInfo()}export {services as Reader};',
    }
    expect(() => discoverNativeAccountCapability(resource)).toThrow('native-account-service')
    environment()
    const readAccountInfo = vi.fn()
    await expect(
      nativeAccountCapability(async () => ({ Reader: { accessInputs: { readAccountInfo } } }), {
        module: resource.url,
        exportName: 'Reader',
        readerProperty: 'accountInfo',
      }),
    ).rejects.toThrow('typed reader missing')
    await expect(
      nativeAccountCapability(async () => ({
        Reader: { accessInputs: { readAccountInfo }, accountInfo: { readAccountInfo } },
      })),
    ).rejects.toThrow('ambiguous')
    expect(readAccountInfo).not.toHaveBeenCalled()
  })
  it('discovers split readers at runtime without invoking access-input getters', async () => {
    environment()
    const readAccountInfo = vi.fn(), getter = vi.fn()
    const service = { accountInfo: { readAccountInfo } }
    Object.defineProperty(service, 'accessInputs', { get: getter })
    const result = await nativeAccountCapability(async () => ({ Reader: service }))
    expect(result.native.TW.accessInputs.readAccountInfo).toBe(readAccountInfo)
    expect(getter).not.toHaveBeenCalled()
    expect(readAccountInfo).not.toHaveBeenCalled()
  })
  it('resolves the export used by the native account query, not a build-specific symbol', () => {
    const resource = {
      url: 'app://-/assets/app-initial-future.js',
      source:
        'let services;async function read(){let input=services?.accessInputs;return input.readAccountInfo()}export {services as Renamed};',
    }
    expect(discoverNativeAccountCapability(resource)).toEqual({ module: resource.url, exportName: 'Renamed' })
    expect(discoverNativeAccountCapabilityFromSyntax(resource, parseNativeSource(resource.source))).toEqual({
      module: resource.url,
      exportName: 'Renamed',
    })
    expect(() =>
      discoverNativeAccountCapability({ ...resource, source: resource.source.replace('readAccountInfo', 'readOther') })
    ).toThrow('native-account-service')
  })
  it('uses only the structurally discovered service export and verifies its runtime method', async () => {
    environment()
    const readAccountInfo = vi.fn()
    const result = await nativeAccountCapability(async () => ({ renamed: { accessInputs: { readAccountInfo } } }), {
      module: 'app://-/assets/app-initial-future.js',
      exportName: 'renamed',
    })
    expect(result.native.TW.accessInputs.readAccountInfo).toBe(readAccountInfo)
    await expect(nativeAccountCapability(async () => ({}), { module: result.module, exportName: 'missing' })).rejects
      .toThrow('typed reader missing')
  })
  it('accepts renamed typed exports without consulting version/build metadata', async () => {
    environment()
    const readAccountInfo = vi.fn()
    const load = vi.fn(async () => ({ ArbitraryExport: { accessInputs: { readAccountInfo } } }))
    const result = await nativeAccountCapability(load)
    expect(result.native.TW.accessInputs.readAccountInfo).toBe(readAccountInfo)
    expect(readAccountInfo).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledWith('app://-/assets/app-initial-future.js')
  })
  it.each(
    [[], ['https://evil.example/assets/app-initial-future.js'], ['app://other/assets/app-initial-future.js'], [
      'app://-/assets/app-initial-a.js',
      'app://-/assets/app-initial-b.js',
    ]].map(names => [names]),
  )('rejects missing, foreign and ambiguous resource identities: %j', async names => {
    environment(names)
    const load = vi.fn()
    await expect(nativeAccountCapability(load)).rejects.toThrow('resource missing or ambiguous')
    expect(load).not.toHaveBeenCalled()
  })
  it('does not invoke arbitrary export getters or fall back to legacy POST', async () => {
    environment()
    const getter = vi.fn(), post = vi.fn()
    const module = { legacy: { getInstance: () => ({ post }) } }
    Object.defineProperty(module, 'getter', { get: getter })
    await expect(nativeAccountCapability(async () => module)).rejects.toThrow('typed reader missing or ambiguous')
    expect(getter).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })
})
