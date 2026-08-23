export type DataMode = 'shared' | 'isolated'

export interface DataRootProjection {
  readonly name: string
  readonly path: string
  /** True when CordisX owns the directory and may enforce private permissions. */
  readonly managed: boolean
}

export type ChromiumProfileProjection =
  | { readonly mode: 'independent'; readonly path: string }
  | { readonly mode: 'system' }

export interface ResolveLaunchPlanInput {
  readonly cordisxHomeDir: string
  readonly profileId: string
  readonly dataMode: DataMode
  readonly executable?: string
  readonly chromiumProfileDir?: string
}

/** Serializable, host-neutral launch information shared by launch and doctor. */
export interface ResolvedLaunchPlan {
  readonly version: 1
  readonly appId: string
  readonly appName: string
  readonly profileId: string
  readonly dataMode: DataMode
  readonly executable: string
  readonly chromiumProfile: ChromiumProfileProjection
  readonly environment: Readonly<Record<string, string>>
  readonly sharedDataRoots: readonly DataRootProjection[]
  readonly isolatedDataRoots: readonly DataRootProjection[]
}

export interface HostAdapter {
  readonly id: string
  readonly displayName: string
  resolveLaunchPlan(input: ResolveLaunchPlanInput): Promise<ResolvedLaunchPlan>
  prepareLaunch(plan: ResolvedLaunchPlan): Promise<void>
}

export class HostAdapterError extends Error {
  constructor(
    readonly code: 'adapter-not-installed' | 'adapter-not-launch-capable',
    message: string,
  ) {
    super(message)
    this.name = 'HostAdapterError'
  }
}
