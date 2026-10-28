import { RetryableCleanup } from '../providers/retryable-cleanup.js'
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
  private pendingCleanup: RetryableCleanup | undefined
  private activeCleanup: RetryableCleanup | undefined

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
    if (this.closed || this.pendingCleanup !== undefined) {
      release()
      throw new Error(this.closed ? 'Platform provider service batch is closed' : 'Provider cleanup requires recovery')
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
    let direction: 'rollback' | 'finalize' | undefined
    const rollback = new RetryableCleanup([
      async () => await transaction.rollback(),
      ...prepared.map(service => async () => await service.dispose()),
    ], 'Platform provider service rollback cleanup failed')
    const finalize = new RetryableCleanup([
      async () => await transaction.finalize(),
      ...previous.map(service => async () => await service.dispose()),
    ], 'Platform provider service finalize cleanup failed')
    const settle = async (cleanup: RetryableCleanup) => {
      this.pendingCleanup = cleanup
      try {
        await cleanup.run()
        if (this.pendingCleanup === cleanup) this.pendingCleanup = undefined
      } finally {
        // Release the queue on failure, but fence new transactions until explicit recovery.
        release()
      }
    }
    return {
      generation: transaction.generation,
      rollback: async () => {
        if (direction === 'finalize') throw new Error('Provider services are finalizing')
        if (rollback.completed) return
        direction = 'rollback'
        await settle(rollback)
      },
      finalize: async () => {
        if (direction === 'rollback') throw new Error('Provider services are rolling back')
        if (finalize.completed) return
        direction = 'finalize'
        this.active = prepared
        // Keep the existing bounded cleanup retry; never retry a business request.
        try {
          await settle(finalize)
        } catch {
          await settle(finalize)
        }
      },
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await this.transactionTail
    if (this.pendingCleanup !== undefined) {
      const cleanup = this.pendingCleanup
      await cleanup.run()
      if (this.pendingCleanup === cleanup) this.pendingCleanup = undefined
    }
    this.activeCleanup ??= new RetryableCleanup(
      this.active.map(service => async () => await service.dispose()),
      'Platform provider service close failed',
    )
    await this.activeCleanup.run()
    this.active = []
  }
}
