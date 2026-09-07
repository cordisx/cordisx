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
const protocolCommit = 'af4b86a1f51a218dfee8e9a734e655dee1000ab5'
const protocolSource = `github:cordisx/cordisx-protocol#${protocolCommit}`
const protocolResolvedSource = `git+ssh://git@github.com/cordisx/cordisx-protocol.git#${protocolCommit}`
const staleProtocolCommit = '3f0dbcd8b04ae83c920d2d913ac2c313af5f83f1'

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

interface PackageLock {
  readonly packages: Readonly<Record<string, PackageManifest & { readonly resolved?: string }>>
}

interface ProtocolPinDocuments {
  readonly rootManifest: PackageManifest
  readonly cliManifest: PackageManifest
  readonly channelRuntimeManifest: PackageManifest
  readonly lockfile: PackageLock
}

function protocolEdges(documents: ProtocolPinDocuments): ReadonlyArray<readonly [string, string | undefined]> {
  const rootLock = documents.lockfile.packages['']
  const cliLock = documents.lockfile.packages['packages/cli']
  const channelRuntimeLock = documents.lockfile.packages['packages/channel-runtime']
  const installed = documents.lockfile.packages['node_modules/@cordisx/protocol']
  return [
    ['package.json dependencies', documents.rootManifest.dependencies?.['@cordisx/protocol']],
    ['package.json devDependencies', documents.rootManifest.devDependencies?.['@cordisx/protocol']],
    ['packages/cli/package.json dependencies', documents.cliManifest.dependencies?.['@cordisx/protocol']],
    ['packages/cli/package.json devDependencies', documents.cliManifest.devDependencies?.['@cordisx/protocol']],
    [
      'packages/channel-runtime/package.json dependencies',
      documents.channelRuntimeManifest.dependencies?.['@cordisx/protocol'],
    ],
    ['package-lock root dependencies', rootLock?.dependencies?.['@cordisx/protocol']],
    ['package-lock root devDependencies', rootLock?.devDependencies?.['@cordisx/protocol']],
    ['package-lock CLI dependencies', cliLock?.dependencies?.['@cordisx/protocol']],
    ['package-lock CLI devDependencies', cliLock?.devDependencies?.['@cordisx/protocol']],
    ['package-lock Channel runtime dependencies', channelRuntimeLock?.dependencies?.['@cordisx/protocol']],
    ['package-lock installed resolution', installed?.resolved],
  ]
}

function protocolPinViolations(documents: ProtocolPinDocuments): string[] {
  return protocolEdges(documents)
    .filter(([label, source]) =>
      source !== (label === 'package-lock installed resolution' ? protocolResolvedSource : protocolSource)
    )
    .map(([label]) => label)
}

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
  it('pins every root, publishable CLI, and lock edge to one exact source dependency', async () => {
    const [rootManifestText, cliManifestText, channelRuntimeManifestText, lockfileText] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(path.join(root, 'packages/cli/package.json'), 'utf8'),
      readFile(path.join(root, 'packages/channel-runtime/package.json'), 'utf8'),
      readFile(path.join(root, 'package-lock.json'), 'utf8'),
    ])
    const documents: ProtocolPinDocuments = {
      rootManifest: JSON.parse(rootManifestText) as PackageManifest,
      cliManifest: JSON.parse(cliManifestText) as PackageManifest,
      channelRuntimeManifest: JSON.parse(channelRuntimeManifestText) as PackageManifest,
      lockfile: JSON.parse(lockfileText) as PackageLock,
    }
    expect(protocolEdges(documents)).toHaveLength(11)
    expect(protocolPinViolations(documents)).toEqual([])
    expect(`${rootManifestText}\n${cliManifestText}\n${lockfileText}`).not.toContain(staleProtocolCommit)
    expect(formalConnectorConsumerSurface).toBeNull()
  })

  it('rejects a stale publishable CLI edge and its independently stale lock edge', () => {
    const currentManifest: PackageManifest = {
      dependencies: { '@cordisx/protocol': protocolSource },
      devDependencies: { '@cordisx/protocol': protocolSource },
    }
    const current: ProtocolPinDocuments = {
      rootManifest: currentManifest,
      cliManifest: currentManifest,
      channelRuntimeManifest: { dependencies: { '@cordisx/protocol': protocolSource } },
      lockfile: {
        packages: {
          '': currentManifest,
          'packages/cli': currentManifest,
          'packages/channel-runtime': { dependencies: { '@cordisx/protocol': protocolSource } },
          'node_modules/@cordisx/protocol': { resolved: protocolResolvedSource },
        },
      },
    }
    const staleSource = `git+https://github.com/cordisx/cordisx-protocol.git#${staleProtocolCommit}`
    expect(protocolPinViolations({
      ...current,
      cliManifest: { ...currentManifest, dependencies: { '@cordisx/protocol': staleSource } },
    })).toEqual(['packages/cli/package.json dependencies'])
    expect(protocolPinViolations({
      ...current,
      lockfile: {
        packages: {
          ...current.lockfile.packages,
          'packages/cli': { ...currentManifest, dependencies: { '@cordisx/protocol': staleSource } },
        },
      },
    })).toEqual(['package-lock CLI dependencies'])
  })
})
