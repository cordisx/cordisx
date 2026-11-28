import type { LarkChannel } from '@larksuiteoapi/node-sdk'

export type FeishuSdkChannel =
  & Pick<LarkChannel, 'connect' | 'disconnect' | 'on' | 'send'>
  & Partial<Pick<LarkChannel, 'rawClient' | 'botIdentity' | 'getChatInfo' | 'getConnectionStatus' | 'updateCard'>>
