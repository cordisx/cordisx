export interface NativeResourceTransformResult {
  /** Complete replacement source. A rejects transforms that do not report one unique anchor. */
  readonly source: string
  readonly anchorMatches: number
  /** Must return true only after this exact transformed resource has executed. */
  readonly acknowledgementExpression: string
  /** Must synchronously remove or disable the transform's renderer-owned authority. */
  readonly fenceExpression: string
}

export interface NativeResourceTransform {
  /** Host-discovered module used by the supplementary native task capability. */
  readonly taskExecutionUrl?: string
  readonly url: string
  readonly sha256: string
  readonly transform: (source: string) => NativeResourceTransformResult
  /** Defaults to true. Lazy transforms remain intercepted but do not block document readiness. */
  readonly requiredForDocumentReady?: boolean
}

export interface NativeAccountCapabilityDescriptor {
  readonly module: string
  readonly exportName: string
  readonly readerProperty?: 'accessInputs' | 'accountInfo'
}

export interface NativeScriptResource {
  readonly url: string
  readonly source: string
}
export interface AdapterContext {
  readonly appVersion: string
  readonly buildNumber: string
  readonly resources: readonly NativeScriptResource[]
  readonly transforms: readonly NativeResourceTransform[]
}
export interface AdapterModuleResult {
  readonly transforms?: readonly NativeResourceTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
}
export interface AdapterModule {
  readonly id: string
  readonly requires: readonly { readonly id: string; readonly samePackage: boolean }[]
  /** Only these dependencies may be explicitly recomposed on the same resource. */
  readonly composes: readonly string[]
  analyze(context: AdapterContext): AdapterModuleResult
}
export interface AdapterBundle {
  readonly apiVersion: 1
  /** Host-owned token admission, first-turn carrier and intermediary security contract. */
  readonly relayContract: 1
  readonly version: string
  /** Local resource discovery may union these structural prefilters across loaded candidates. */
  readonly resourceHints: readonly (readonly string[])[]
  readonly modules: readonly AdapterModule[]
}
