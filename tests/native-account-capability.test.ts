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
