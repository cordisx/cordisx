import { describe, expect, it } from 'vitest'
import { nativeLaunchConfiguration } from '../packages/cli/assets/launcher/native-launch-configuration.mjs'

describe('owned native launch configuration', () => {
  it('keeps the child environment clean and sets a verified catalog only on app-server', () => {
    const environment = {
      CORDISX_NATIVE_CONTROL_SOCKET: '/socket',
      CORDISX_NATIVE_CONTROL_NONCE: 'secret',
      CORDISX_NATIVE_REAL_CODEX_PATH: '/codex',
      CORDISX_NATIVE_CLI_ENTRY_PATH: '/entry',
      CORDISX_NATIVE_AGENT_MODELS_BINDING: '/binding',
      CORDISX_NATIVE_STATIC_CATALOG_PATH: '/catalog',
      CORDISX_NATIVE_STATIC_CATALOG_SHA256: 'a'.repeat(64),
      CORDISX_NATIVE_STATIC_CATALOG_VERSION: '0.167.0-alpha.3.2',
      HOME: '/home',
    }
    const launch = nativeLaunchConfiguration(environment, ['app-server', '--stdio'], '/node')
    expect(launch.nativeArgs).toContain('model_catalog_json="/catalog"')
    expect(launch.nativeArgs).toContain('model_provider="openai"')
    expect(launch.nativeArgs).toContain('mcp_servers.cordisx_models.command="/node"')
    expect(environment).toEqual({ HOME: '/home' })
    expect(launch.socketPath).toBe('/socket')
    const other = nativeLaunchConfiguration({
      CORDISX_NATIVE_CONTROL_SOCKET: '/s',
      CORDISX_NATIVE_CONTROL_NONCE: 'n',
      CORDISX_NATIVE_REAL_CODEX_PATH: '/codex',
      CORDISX_NATIVE_STATIC_CATALOG_PATH: '/catalog',
      CORDISX_NATIVE_STATIC_CATALOG_SHA256: 'a'.repeat(64),
      CORDISX_NATIVE_STATIC_CATALOG_VERSION: '0.167.0-alpha.3.2',
    }, ['--version'])
    expect(other.nativeArgs).toEqual(['--version'])
  })
})
