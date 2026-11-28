import { vi } from 'vitest'
import type {
  ManagedServiceControlResultV1,
  ManagedServiceProjectionV1 as RuntimeManagedServiceProjectionV1,
  ManagedServiceRegistrationHandleV1,
} from '@cordisx/protocol/managed-service-runtime/v1'

export function runtimeProjection(
  overrides: Partial<RuntimeManagedServiceProjectionV1> = {},
): RuntimeManagedServiceProjectionV1 {
  return Object.freeze({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-projection.v1.schema.json',
    contract: 'cordisx.managed-service-projection/v1',
    schemaVersion: 1,
    binding: Object.freeze({
      registrationHandle: 'msr_test' as `msr_${string}`,
      serviceHandle: 'mss_test' as `mss_${string}`,
      identity: Object.freeze({
        source: 'https://plugins.example.test/test-plugin' as `https://${string}`,
        pluginId: 'test-plugin',
        serviceId: 'test-service',
      }),
      hostGeneration: 'host-one',
      serviceGeneration: 'svc-gen',
    }),
    state: 'ready',
    health: 'ready',
    processOwnership: 'host-owned',
    configuration: Object.freeze({ state: 'not-required' as const }),
    authentication: Object.freeze({ state: 'not-required' as const }),
    httpAuthorization: Object.freeze({ state: 'not-required' as const }),
    ...overrides,
  })
}

export function fakeRegistrationHandle(
  projection: RuntimeManagedServiceProjectionV1,
  authenticateResult: ManagedServiceControlResultV1 = {
    status: 'accepted',
    projection,
  },
): ManagedServiceRegistrationHandleV1 {
  return {
    binding: projection.binding,
    revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    inspect: vi.fn().mockResolvedValue(projection),
    authenticate: vi.fn().mockResolvedValue(authenticateResult),
    ensureReady: vi.fn().mockResolvedValue({ status: 'ready', projection }),
    restart: vi.fn(),
    publishNativeProvider: vi.fn(),
    dispose: vi.fn(),
  }
}

export function baseOptions(overrides: Partial<{
  profileId: string
  runtimeGeneration: string
  healthIntervalMs: number
  authenticationMode: 'none' | 'host-secret' | 'cli'
  logoutAvailable: boolean
}> = {}) {
  const projection = runtimeProjection()
  return {
    profileId: overrides.profileId ?? 'default',
    runtimeGeneration: overrides.runtimeGeneration ?? 'runtime-1',
    registrationHandle: fakeRegistrationHandle(projection),
    healthIntervalMs: overrides.healthIntervalMs ?? 250,
    displayName: 'Test Service',
    serviceKind: 'managed-backend',
    pluginId: 'test-plugin',
    pluginGeneration: 'plugin-1',
    serviceId: 'test-service',
    source: 'https://plugins.example.test/test-plugin' as `https://${string}`,
    authenticationMode: overrides.authenticationMode ?? 'none',
    logoutAvailable: overrides.logoutAvailable ?? false,
  }
}
