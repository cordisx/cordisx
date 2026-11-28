import { parseHomeConfig } from '../config/home-config.js'
import type { OwnerPolicyTransition } from '../owner-policy-handoff.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  mergePersistedPermissionPolicies,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionRecordKey,
} from '../permission-persistence.js'
import { launchFingerprint } from './launch-fingerprint.js'

type Launch = Omit<Parameters<typeof launchFingerprint>[0], 'source' | 'excludePermissions'>

function samePolicies(left: readonly CordisXPersistedPermissionPolicyRecord[], right: readonly unknown[]): boolean {
  const canonical = (records: readonly unknown[]) =>
    records.map(record => normalizePersistedPermissionPolicyRecord(record))
      .sort((a, b) => persistedPermissionRecordKey(a).localeCompare(persistedPermissionRecordKey(b)))
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

/**
 * Update the launch fingerprint only for an owner-signed policy transition
 * already adopted by every local renderer. Unrelated configuration or policy
 * edits are never absorbed into the running client's recorded intent.
 */
export class OwnerAdapterLaunchIntent {
  private policies: readonly CordisXPersistedPermissionPolicyRecord[]
  private readonly stable: string
  private published: string
  private desired: string
  private ready = false
  private current: boolean
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly input: {
      readonly initialSource: string
      readonly initialFingerprint: string
      readonly launch: Launch
      readonly readSource: () => Promise<string>
      readonly publish: (expected: string, next: string) => Promise<boolean>
    },
  ) {
    this.policies = parseHomeConfig(JSON.parse(input.initialSource)).permissions
    this.stable = launchFingerprint({ ...input.launch, source: input.initialSource, excludePermissions: true })
    this.published = input.initialFingerprint
    this.desired = input.initialFingerprint
    this.current = launchFingerprint({ ...input.launch, source: input.initialSource }) === input.initialFingerprint
  }

  async adopted(transition: OwnerPolicyTransition): Promise<void> {
    if (!this.current) return
    try {
      const updates = transition.updates.map(record => normalizePersistedPermissionPolicyRecord(record))
      const update = updates[0]
      if (
        updates.length !== 1 || !update || update.key.profileId !== transition.profileId
        || update.key.identity.pluginId !== transition.identity.id
        || update.key.identity.source !== transition.identity.source
      ) {
        this.current = false
        return
      }
      const relevant = (record: CordisXPersistedPermissionPolicyRecord) =>
        isPermissionPolicyRecordV2(update)
          ? isPermissionPolicyRecordV2(record)
            && persistedPermissionRecordKey(record) === persistedPermissionRecordKey(update)
          : isPermissionPolicyRecordV3(record) && record.key.profileId === transition.profileId
            && record.key.identity.pluginId === transition.identity.id
            && record.key.identity.source === transition.identity.source
            && record.key.capability === 'ui.extension-points.render' && record.key.scope.extensionPoints?.length === 1
            && ['manager.settings.navigation-items', 'manager.content'].includes(record.key.scope.extensionPoints[0]!)
      if (!updates.every(relevant) || !samePolicies(this.policies.filter(relevant), transition.expected)) {
        this.current = false
        return
      }
      const candidate = mergePersistedPermissionPolicies(this.policies, updates)
      if (!samePolicies(candidate.filter(relevant), transition.candidate)) {
        this.current = false
        return
      }
      const source = await this.input.readSource()
      const config = parseHomeConfig(JSON.parse(source))
      if (
        this.stable !== launchFingerprint({ ...this.input.launch, source, excludePermissions: true })
        || !samePolicies(candidate, config.permissions)
      ) {
        this.current = false
        return
      }
      this.policies = candidate
      this.desired = launchFingerprint({ ...this.input.launch, source })
      await this.flush()
    } catch {
      // This bookkeeping must never weaken or interrupt the actual policy handoff.
      this.current = false
    }
  }

  async markReady(): Promise<void> {
    this.ready = true
    await this.flush()
  }

  private async flush(): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.current || !this.ready || this.published === this.desired) return
      const next = this.desired
      if (!await this.input.publish(this.published, next)) {
        this.current = false
        return
      }
      this.published = next
    }).catch(() => {
      this.current = false
    })
    await this.queue
  }
}
