import type { HttpClientV1 } from '@cordisx/protocol/plugin-http/v1'
export type * from '@cordisx/protocol/plugin-http/v1'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly http: HttpClientV1
  }
}
