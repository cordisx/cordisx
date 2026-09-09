import type { DialogsV1 } from '@cordisx/protocol/dialogs/v1'
export type * from '@cordisx/protocol/dialogs/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly dialogs: DialogsV1
  }
}
