import type { CodexProviderConfig } from '../providers/contracts.js'
import type { ProviderFleet } from '../providers/fleet.js'
import type { PlatformProviderRuntimeServiceModuleAccess } from './packages/authority.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ActivePlatformProviderServiceV1 } from './platform-provider-service-host.js'
import { PlatformProviderServiceHostV1 } from './platform-provider-service-host.js'
import type {
  HostPlatformProviderBrokerAuthorityV1,
  HostPlatformProviderConfigurationRegistryV1,
} from './platform-provider-authority.js'

export interface PlatformProviderServiceCandidate {
  readonly access: PlatformProviderRuntimeServiceModuleAccess
  readonly rawConfiguration: unknown
}

export interface PlatformProviderServiceConfigurationOverride {
  readonly pluginId: string
  readonly serviceId: string
  readonly rawConfiguration: unknown
}

export function platformProviderCandidateConfiguration(
  candidate: PlatformProviderServiceCandidate,
  override?: PlatformProviderServiceConfigurationOverride,
): unknown {
  return override?.pluginId === candidate.access.pluginIdentity.pluginId
      && override.serviceId === candidate.access.serviceId
    ? override.rawConfiguration
    : candidate.rawConfiguration
}

export interface PlatformProviderServiceReconfigureRuntime {
  reconfigure(
    fleet: ProviderFleet,
    configs: readonly CodexProviderConfig[],
    override?: PlatformProviderServiceConfigurationOverride,
    activation?: CordisXPluginActivationRecordV1,
  ): ReturnType<ProviderFleet['reconfigure']>
}

export class PlatformProviderServiceBatchRuntime implements PlatformProviderServiceReconfigureRuntime {
  private active: readonly ActivePlatformProviderServiceV1[] = []
  private serviceGeneration = 0
  private transactionTail: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private readonly options: {
      readonly configurations: HostPlatformProviderConfigurationRegistryV1
      readonly brokers: HostPlatformProviderBrokerAuthorityV1
      readonly candidates: (
        activation?: CordisXPluginActivationRecordV1,
      ) => Promise<readonly PlatformProviderServiceCandidate[]>
    },
  ) {}

  async hasCandidates(): Promise<boolean> {
    if (this.closed) return false
    return (await this.options.candidates()).length > 0
  }

  async reconfigure(
    fleet: ProviderFleet,
    configs: readonly CodexProviderConfig[],
    override?: PlatformProviderServiceConfigurationOverride,
    activation?: CordisXPluginActivationRecordV1,
  ) {
    let release!: () => void
    const previousTransaction = this.transactionTail
    this.transactionTail = new Promise<void>(resolve => {
      release = resolve
    })
    await previousTransaction
    if (this.closed) {
      release()
      throw new Error('Platform provider service batch is closed')
    }
    let prepared: ActivePlatformProviderServiceV1[] = []
    let transaction: Awaited<ReturnType<ProviderFleet['reconfigure']>>
    try {
      transaction = await fleet.reconfigure(configs, async replacement => {
        const host = new PlatformProviderServiceHostV1({
          configurations: this.options.configurations,
          brokers: this.options.brokers,
          fleet: replacement,
        })
        try {
          for (const candidate of await this.options.candidates(activation)) {
            const access = {
              ...candidate.access,
              hostGeneration: `${candidate.access.hostGeneration}:service-${++this.serviceGeneration}`,
            }
            prepared.push(
              await host.activate(
                access,
                platformProviderCandidateConfiguration(candidate, override),
              ),
            )
          }
        } catch (error) {
          await Promise.allSettled(prepared.map(async service => await service.dispose()))
          prepared = []
          throw error
        }
      })
    } catch (error) {
      release()
      throw error
    }
    const previous = this.active
    let state: 'open' | 'rolled-back' | 'finalized' | 'failed' = 'open'
    let terminalFailure: unknown
    return {
      generation: transaction.generation,
      rollback: async () => {
        if (state !== 'open') return
        state = 'rolled-back'
        try {
          await transaction.rollback()
        } finally {
          await Promise.allSettled(prepared.map(async service => await service.dispose()))
          release()
        }
      },
      finalize: async () => {
        if (state === 'finalized' || state === 'rolled-back') return
        if (state === 'failed') throw terminalFailure
        try {
          let finalized = false
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await transaction.finalize()
              finalized = true
              break
            } catch (error) {
              terminalFailure = error
            }
          }
          if (!finalized) throw terminalFailure
          await Promise.allSettled(previous.map(async service => await service.dispose()))
          this.active = prepared
          state = 'finalized'
          release()
        } catch (error) {
          state = 'failed'
          terminalFailure = error
          release()
          throw error
        }
      },
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.transactionTail
    const active = this.active
    this.active = []
    await Promise.allSettled(active.map(async service => await service.dispose()))
  }
}
