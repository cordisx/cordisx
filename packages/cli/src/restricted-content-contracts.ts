import type { IsolatedGameUiV1 } from '@cordisx/protocol/isolated-game-ui/v1'
import type { RestrictedContentV1 } from '@cordisx/protocol/restricted-content/v1'
export type * from '@cordisx/protocol/restricted-content/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly isolatedGameUi: IsolatedGameUiV1
    readonly restrictedContent: RestrictedContentV1
  }
}
