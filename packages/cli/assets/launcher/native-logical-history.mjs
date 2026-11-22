/** Only the Host-owned dynamic tool is consumed; unrelated native requests reach Desktop. */
export function dispatchLogicalHistory(message, { controlCall, writeNative, stop }) {
  if (
    message.method !== 'item/tool/call' || message.id === undefined
    || message.params?.tool !== 'cordisx_continuation_history' || message.params?.namespace != null
  ) return false
  const unavailable = { success: false, contentItems: [{ type: 'inputText', text: '{"status":"unavailable"}' }] }
  void controlCall('logical-history', { params: message.params })
    .catch(() => unavailable)
    .then(result => writeNative({ id: message.id, result }))
    .catch(stop)
  return true
}

/** Strip the Host ticket and authorize the exact native request before forwarding it. */
export async function forwardLogicalTurn(
  message,
  params,
  config,
  token,
  { controlCall, desktopCalls, writeNative, transform },
) {
  const nextConfig = { ...config }
  delete nextConfig['cordisx.operation_token']
  if (Object.keys(nextConfig).length) params.config = nextConfig
  else delete params.config
  if (await controlCall('authorize', { token, requestId: message.id }) !== true) {
    throw new Error('Logical turn authorization expired')
  }
  desktopCalls.set(message.id, { token, method: message.method, logicalTurn: true, threadId: params.threadId })
  await writeNative(JSON.stringify(transform(message)))
}
