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
const protocolVersion = '0.1.0-beta.7'
const protocolResolvedSource = `https://registry.npmjs.org/@cordisx/protocol/-/protocol-${protocolVersion}.tgz`
const protocolIntegrity =
  'sha512-6ZBTAd2O9oiOAjN6w4H7rOhxbr+HDu0ZqsWSeHMZ3jItXZBuHpik6RqXIgpyFtVm2ttLsFu9A/u20SekXx8fKw=='
const staleProtocolVersion = '0.1.0-beta.2'

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

interface LockedPackage extends PackageManifest {
  readonly version?: string
  readonly resolved?: string
  readonly integrity?: string
}

interface PackageLock {
  readonly packages: Readonly<Record<string, LockedPackage>>
}

interface ProtocolPinDocuments {
  readonly rootManifest: PackageManifest
  readonly cliManifest: PackageManifest
  readonly lockfile: PackageLock
}

function protocolEdges(documents: ProtocolPinDocuments): ReadonlyArray<readonly [string, string | undefined]> {
  const rootLock = documents.lockfile.packages['']
  const cliLock = documents.lockfile.packages['packages/cli']
  const installed = documents.lockfile.packages['node_modules/@cordisx/protocol']
  return [
    ['package.json dependencies', documents.rootManifest.dependencies?.['@cordisx/protocol']],
    ['package.json devDependencies', documents.rootManifest.devDependencies?.['@cordisx/protocol']],
    ['packages/cli/package.json dependencies', documents.cliManifest.dependencies?.['@cordisx/protocol']],
    ['packages/cli/package.json devDependencies', documents.cliManifest.devDependencies?.['@cordisx/protocol']],
    ['package-lock root dependencies', rootLock?.dependencies?.['@cordisx/protocol']],
    ['package-lock root devDependencies', rootLock?.devDependencies?.['@cordisx/protocol']],
    ['package-lock CLI dependencies', cliLock?.dependencies?.['@cordisx/protocol']],
    ['package-lock CLI devDependencies', cliLock?.devDependencies?.['@cordisx/protocol']],
    ['package-lock installed version', installed?.version],
    ['package-lock installed resolution', installed?.resolved],
    ['package-lock installed integrity', installed?.integrity],
  ]
}

function expectedProtocolEdge(label: string): string | undefined {
  if (label.includes('devDependencies')) return undefined
  if (label === 'package-lock installed resolution') return protocolResolvedSource
  if (label === 'package-lock installed integrity') return protocolIntegrity
  return protocolVersion
}

function protocolPinViolations(documents: ProtocolPinDocuments): string[] {
  return protocolEdges(documents)
    .filter(([label, source]) => source !== expectedProtocolEdge(label))
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
  it('pins the Host root, publishable CLI, and lockfile to one exact registry dependency', async () => {
    const [rootManifestText, cliManifestText, lockfileText] = await Promise.all([
      readFile(path.join(root, 'package.json'), 'utf8'),
      readFile(path.join(root, 'packages/cli/package.json'), 'utf8'),
      readFile(path.join(root, 'package-lock.json'), 'utf8'),
    ])
    const documents: ProtocolPinDocuments = {
      rootManifest: JSON.parse(rootManifestText) as PackageManifest,
      cliManifest: JSON.parse(cliManifestText) as PackageManifest,
      lockfile: JSON.parse(lockfileText) as PackageLock,
    }
    expect(protocolEdges(documents)).toHaveLength(11)
    expect(protocolPinViolations(documents)).toEqual([])
    expect(`${rootManifestText}\n${cliManifestText}\n${lockfileText}`).not.toContain(
      JSON.stringify(staleProtocolVersion),
    )
    expect(lockfileText).not.toContain('github:cordisx/cordisx-protocol')
    expect(formalConnectorConsumerSurface).toBeNull()
  })

  it('rejects stale manifest, lock, and integrity edges', () => {
    const currentManifest: PackageManifest = {
      dependencies: { '@cordisx/protocol': protocolVersion },
    }
    const current: ProtocolPinDocuments = {
      rootManifest: currentManifest,
      cliManifest: currentManifest,
      lockfile: {
        packages: {
          '': currentManifest,
          'packages/cli': currentManifest,
          'node_modules/@cordisx/protocol': {
            version: protocolVersion,
            resolved: protocolResolvedSource,
            integrity: protocolIntegrity,
          },
        },
      },
    }
    expect(protocolPinViolations({
      ...current,
      cliManifest: { dependencies: { '@cordisx/protocol': staleProtocolVersion } },
    })).toEqual(['packages/cli/package.json dependencies'])
    expect(protocolPinViolations({
      ...current,
      lockfile: {
        packages: {
          ...current.lockfile.packages,
          'packages/cli': { dependencies: { '@cordisx/protocol': staleProtocolVersion } },
        },
      },
    })).toEqual(['package-lock CLI dependencies'])
    expect(protocolPinViolations({
      ...current,
      lockfile: {
        packages: {
          ...current.lockfile.packages,
          'node_modules/@cordisx/protocol': {
            version: protocolVersion,
            resolved: protocolResolvedSource,
            integrity: 'sha512-stale',
          },
        },
      },
    })).toEqual(['package-lock installed integrity'])
  })
})
