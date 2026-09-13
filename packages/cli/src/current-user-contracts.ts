import type { CurrentUserV1 } from '@cordisx/protocol/current-user/v1'
export type * from '@cordisx/protocol/current-user/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly currentUser: CurrentUserV1
  }
}
