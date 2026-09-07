import type { ExtensionPointVisualSnapshotV2 } from '@cordisx/protocol/extension-point-visual/v2'
export type * from '@cordisx/protocol/extension-point-visual/v2'
import type { ComponentType } from 'react'
import type {
  ExtensionPointInteractionV1,
  ExtensionPointVisualIdV1,
  ExtensionPointVisualSnapshotV1,
} from '@cordisx/protocol/extension-point-visual/v1'
export type * from '@cordisx/protocol/extension-point-visual/v1'

export interface CordisXReactVisualProps {
  readonly state: ExtensionPointVisualSnapshotV1 | ExtensionPointVisualSnapshotV2
}
export interface CordisXReactVisual {
  readonly kind: 'react-svg-v1'
  readonly component: ComponentType<CordisXReactVisualProps>
}
export interface CordisXVisualRegistration {
  readonly id: string
  readonly pointId: ExtensionPointVisualIdV1
  readonly events?: readonly ExtensionPointInteractionV1[]
  readonly order?: number
  /** Opt into dictation status; omission retains the frozen v1 snapshot. */
  readonly snapshotVersion?: 1 | 2
}
export interface CordisXExtensionPointVisuals {
  register(
    registration: CordisXVisualRegistration,
    load: () => Promise<CordisXReactVisual>,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    extensionPointVisuals: CordisXExtensionPointVisuals
  }
}
