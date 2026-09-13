import type { HttpClientV3 } from '@cordisx/protocol/plugin-http/v3'
export type * from '@cordisx/protocol/plugin-http/v3'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly http: HttpClientV3
  }
}
