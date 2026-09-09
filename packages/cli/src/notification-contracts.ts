import type { NotificationsV1 } from '@cordisx/protocol/notifications/v1'
export type * from '@cordisx/protocol/notifications/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly notifications: NotificationsV1
  }
}
