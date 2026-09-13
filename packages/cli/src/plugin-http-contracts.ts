import type { HttpClientV4 } from '@cordisx/protocol/plugin-http/v4'
export type * from '@cordisx/protocol/plugin-http/v4'
declare module '@deepseek-ai/cordis' {
  interface Context {
    readonly http: HttpClientV4
  }
}
