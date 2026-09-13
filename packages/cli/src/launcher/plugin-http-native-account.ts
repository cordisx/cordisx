import type { CdpSession } from './cdp-session.js'
import { CURRENT_USER_NATIVE_PINS } from '../current-user-native-pins.js'
import { readPinnedNativeAccount } from '../current-user-native-account.js'
import {
  HTTP_NATIVE_ACCOUNT_UNAVAILABLE_REASONS,
  type HttpNativeAccountUnavailableReason,
  type HttpNativeAccountValue,
  HttpNativeCallingContextUnavailableError,
  isHttpNativeAccountUnavailableReason,
} from './plugin-http-native-account-diagnostics.js'
/** Launcher executes in the actual calling native context. Never accept account facts from plugin RPC input. */
export const HTTP_NATIVE_ACCOUNT_EXPRESSION = `(async()=>{
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),2000);
  const fail=reason=>({status:'unavailable',reason});let phase='native-pin-read-exception';
  try {
    if(globalThis.codexWindowType!=='electron'||globalThis.location?.href!=='app://-/index.html')return fail('context-rejected');
    const pin=await globalThis.electronBridge?.getSentryInitOptions?.();
    const adapter=${
  JSON.stringify(CURRENT_USER_NATIVE_PINS)
}.find(x=>x.appVersion===pin?.appVersion&&x.buildNumber===pin?.buildNumber&&x.buildFlavor===pin?.buildFlavor);
    if(!adapter)return fail('native-pin-unavailable');
    phase='native-module-unavailable';const native=await import(adapter.module);
    phase='native-read-exception';const value=await (${readPinnedNativeAccount.toString()})(adapter.buildNumber,native,abort.signal);
    if(abort.signal.aborted)return fail('native-read-timeout');
    if(typeof value?.accountId!=='string'||!value.accountId||typeof value?.userId!=='string'||!value.userId)return fail('native-identity-invalid');
    return JSON.stringify([value.accountId,value.userId]);
  }catch(error){
    if(abort.signal.aborted)return fail('native-read-timeout');
    const reason=error?.nativeAccountReason;
    return fail(${JSON.stringify(HTTP_NATIVE_ACCOUNT_UNAVAILABLE_REASONS)}.includes(reason)?reason:phase);
  }finally{clearTimeout(timer)}
})()`

/** Failure details stay private; calling-context failures never become Native identity observations. */
export async function readNativeHttpAccount(
  session: Pick<CdpSession, 'send'>,
  contextId: unknown,
  active: () => boolean,
  onUnavailable?: (reason: HttpNativeAccountUnavailableReason) => void,
): Promise<HttpNativeAccountValue> {
  const unavailable = (reason: HttpNativeAccountUnavailableReason): HttpNativeAccountValue => {
    try {
      onUnavailable?.(reason)
    } catch { /* Diagnostic listeners cannot affect identity authority. */ }
    if (
      reason === 'reader-closed' || reason === 'context-missing'
      || reason === 'context-unavailable' || reason === 'context-rejected'
    ) return new HttpNativeCallingContextUnavailableError(reason)
    return null
  }
  if (!active()) return unavailable('reader-closed')
  if (!Number.isInteger(contextId) || Number(contextId) < 1) return unavailable('context-missing')
  try {
    const evaluated = await session.send('Runtime.evaluate', {
      expression: HTTP_NATIVE_ACCOUNT_EXPRESSION,
      contextId,
      awaitPromise: true,
      returnByValue: true,
      timeout: 3000,
    }, 3500)
    if (!active()) return unavailable('reader-closed')
    if (evaluated.exceptionDetails !== undefined) return unavailable('native-evaluation-exception')
    const result = (evaluated.result as { value?: unknown } | undefined)?.value
    if (typeof result === 'string') return result
    const failure = result as { status?: unknown; reason?: unknown } | null
    return unavailable(
      failure?.status === 'unavailable' && isHttpNativeAccountUnavailableReason(failure.reason)
        ? failure.reason
        : 'native-result-invalid',
    )
  } catch (error) {
    if (!active()) return unavailable('reader-closed')
    const message = error instanceof Error ? error.message : ''
    if (/^CDP connection (?:is )?closed$/u.test(message)) return unavailable('reader-closed')
    if (message === 'CDP request timed out: Runtime.evaluate') return unavailable('cdp-read-timeout')
    if (/^CDP -32000: (?:Cannot find context with specified id|Execution context was destroyed)/u.test(message)) {
      return unavailable('context-unavailable')
    }
    return unavailable('cdp-read-exception')
  }
}
