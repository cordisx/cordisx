import { JsonLineRpcError } from '../providers/json-line-rpc.js'

/** These 0.149 native replies prove the requested turn did not accept the input. */
export function channelSteerNotActive(error: unknown, expectedTurnId: string): boolean {
  return error instanceof JsonLineRpcError && error.rpcCode === -32600
    && (error.message === 'no active turn to steer'
      || error.message.startsWith(
        'expected active turn id ' + String.fromCharCode(96) + expectedTurnId
          + String.fromCharCode(96) + ' but found ',
      ))
}
