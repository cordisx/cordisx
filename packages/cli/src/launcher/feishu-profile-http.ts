import { defaultHttpInstance, type HttpInstance, type HttpRequestOptions } from '@larksuiteoapi/node-sdk'
import type { FeishuBotProfile } from './channel-account-identity.js'

/** Retains only the identity fields of the SDK's existing authenticated bot-info request. */
export function feishuProfileHttp(onProfile: (profile: FeishuBotProfile) => void): HttpInstance {
  // The SDK exports its Axios instance with Axios response types, but its
  // response interceptor returns data and createLarkChannel consumes HttpInstance.
  const http = defaultHttpInstance as unknown as HttpInstance
  const request = async <T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> => {
    const result = await http.request<T, R, D>(options)
    let path: string | undefined
    try {
      path = new URL(options.url ?? '', 'https://open.feishu.cn').pathname
    } catch {
      return result
    }
    if (path !== '/open-apis/bot/v3/info' || options.method?.toUpperCase() !== 'GET') return result
    if (result === null || typeof result !== 'object') return result
    const bot = (result as { bot?: unknown }).bot
    if (bot === null || typeof bot !== 'object') return result
    const value = bot as Record<string, unknown>
    if (typeof value.open_id !== 'string' || value.open_id === '') return result
    // Never retain open_id, auth headers or the original gateway response.
    try {
      onProfile({
        ...(typeof value.app_name === 'string' ? { name: value.app_name } : {}),
        ...(typeof value.avatar_url === 'string' ? { avatarUrl: value.avatar_url } : {}),
      })
    } catch {
      // Decorative identity must never change the SDK connection result.
    }
    return result
  }
  // Preserve all original methods and interceptors, including inherited members.
  return new Proxy(http, {
    get(target, key, receiver) {
      return key === 'request' ? request : Reflect.get(target, key, receiver)
    },
  })
}
