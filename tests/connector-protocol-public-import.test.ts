import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  BoundConnectorClient,
  BoundConnectorClientResult,
  ConnectorCommand,
  ConnectorEvent,
  ConnectorEventPage,
  ConnectorRegistrationIdentity,
  ConnectorServiceDescriptor,
  ConnectorSubscribeRuntimeResult,
  ConnectorSubscription,
} from '@cordisx/protocol/connector-service/v1'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const protocolCommit = '49f1223fb7e6a340080de58629280b0f3de9faed'

// This tuple is compile-only: it makes the formal public type surface part of
// the Host test program without copying declarations or importing a checkout.
type FormalConnectorConsumerSurface = readonly [
  BoundConnectorClient,
  ConnectorServiceDescriptor,
  ConnectorRegistrationIdentity,
  ConnectorCommand,
  ConnectorEvent,
  ConnectorEventPage,
  ConnectorSubscription,
  BoundConnectorClientResult,
  ConnectorSubscribeRuntimeResult,
]

const formalConnectorConsumerSurface = null as unknown as FormalConnectorConsumerSurface

describe('formal Connector Protocol public type import', () => {
  it('pins the merged source dependency and compiles the public consumer entry', async () => {
    const [manifest, lockfile] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(path.join(root, 'package-lock.json'), 'utf8'),
    ])
    expect(manifest).toContain(`cordisx-protocol.git#${protocolCommit}`)
    expect(lockfile).toContain(`cordisx-protocol.git#${protocolCommit}`)
    expect(lockfile).not.toContain('cordisx-protocol.git#d4c9220')
    expect(formalConnectorConsumerSurface).toBeNull()
  })
})
