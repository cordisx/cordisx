import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  PlatformProviderBrokerPolicyV1,
  PlatformProviderOwnerV1,
  PlatformProviderWorkspaceRefV1,
} from '@cordisx/protocol/platform-provider/v1'
import type { PlatformProviderFactoryConfiguration } from './platform-provider-service-types.js'
import type {
  HostPlatformProviderBrokerCatalogV1,
  HostPlatformProviderBrokerTransportV1,
} from './platform-provider-broker.js'

export class PlatformProviderWorkspaceAuthority {
  private readonly paths = new Map<string, string>()

  issue(cwd: string): PlatformProviderWorkspaceRefV1 {
    const resolved = path.resolve(cwd)
    const workspaceHandle = `ppw_${randomUUID()}` as const
    this.paths.set(workspaceHandle, resolved)
    return Object.freeze({ workspaceHandle })
  }

  resolve(workspace: PlatformProviderWorkspaceRefV1): string {
    const resolved = this.paths.get(workspace.workspaceHandle)
    if (resolved === undefined) throw new Error('Platform provider workspace handle is stale')
    return resolved
  }

  dispose(): void {
    this.paths.clear()
  }
}

export interface HostPlatformProviderConfigurationContractV1 {
  readonly protocolVersion: 1 | 2
  readonly schema: string
  readonly applicationMode: 'service-restart' | 'app-restart'
  project(value: unknown): readonly PlatformProviderFactoryConfiguration[]
}

export class HostPlatformProviderConfigurationRegistryV1 {
  private readonly contracts = new Map<string, HostPlatformProviderConfigurationContractV1>()

  register(contract: HostPlatformProviderConfigurationContractV1): () => void {
    if (this.contracts.has(contract.schema)) {
      throw new Error(`Platform provider schema ${contract.schema} is registered`)
    }
    this.contracts.set(contract.schema, contract)
    return () => {
      if (this.contracts.get(contract.schema) === contract) this.contracts.delete(contract.schema)
    }
  }

  resolve(schema: string, applicationMode: 'service-restart' | 'app-restart') {
    const contract = this.contracts.get(schema)
    if (contract === undefined || contract.applicationMode !== applicationMode) {
      throw new Error(`Platform provider schema ${schema} is unsupported`)
    }
    return contract
  }
}

export interface HostPlatformProviderBrokerAuthorityV1 {
  catalog(schema: string): HostPlatformProviderBrokerCatalogV1
  open(input: {
    readonly owner: PlatformProviderOwnerV1
    readonly configuration: PlatformProviderFactoryConfiguration
    readonly rawConfiguration: unknown
    readonly policy: PlatformProviderBrokerPolicyV1
    readonly workspaces: PlatformProviderWorkspaceAuthority
  }): Promise<HostPlatformProviderBrokerTransportV1>
}
