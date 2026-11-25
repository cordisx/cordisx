import assert from 'node:assert/strict'
import test from 'node:test'
import { installedCliProxyBridge } from './check-installed-cli-proxy.mjs'

test('requires the Go discovery path with Node architecture metadata on Linux x64', () => {
  const bridge = {
    path: './runtime/cli-proxy-plugins/linux/amd64/cordisx-gateway-bridge.so',
    mode: 'executable',
    platforms: ['linux'],
    architectures: ['x64'],
  }
  assert.equal(installedCliProxyBridge([bridge], 'linux', 'x64'), bridge)
  assert.throws(() =>
    installedCliProxyBridge(
      [
        { ...bridge, path: './runtime/cli-proxy-plugins/linux/x64/cordisx-gateway-bridge.so' },
      ],
      'linux',
      'x64',
    ), /native discovery/)
  assert.throws(() => installedCliProxyBridge([{ ...bridge, architectures: ['arm64'] }], 'linux', 'x64'))
})

test('preserves the macOS arm64 discovery path and skips other targets', () => {
  const bridge = {
    path: './runtime/cli-proxy-plugins/darwin/arm64/cordisx-gateway-bridge.dylib',
    mode: 'executable',
    platforms: ['darwin'],
    architectures: ['arm64'],
  }
  assert.equal(installedCliProxyBridge([bridge], 'darwin', 'arm64'), bridge)
  assert.equal(installedCliProxyBridge([], 'linux', 'arm64'), undefined)
})
