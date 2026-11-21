import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialized') return
  if (message.method !== 'model/list') {
    process.stdout.write(JSON.stringify({ id: message.id, result: { received: message.params } }) + '\n')
    return
  }
  const providerId = message.params?.modelProvider
  if (providerId === undefined || providerId === null || providerId === 'native-success') {
    process.stdout.write(
      JSON.stringify({ id: message.id, result: { data: [{ id: 'native' }], nextCursor: null } }) + '\n',
    )
    return
  }
  if (providerId === 'missing-error-data' || providerId === 'missing-error-provider') {
    const error = providerId === 'missing-error-data'
      ? { code: -32600, message: 'provider not configured' }
      : { code: -32600, message: 'provider not configured', data: { type: 'modelProviderNotConfigured' } }
    process.stdout.write(JSON.stringify({ id: message.id, error }) + '\n')
    return
  }
  const error = providerId === 'network-error'
    ? { code: -32000, message: 'network error' }
    : {
      code: -32600,
      message: 'provider not configured',
      data: {
        type: 'modelProviderNotConfigured',
        modelProvider: providerId === 'wrong-error-provider' ? 'other' : providerId,
      },
    }
  const send = () => process.stdout.write(JSON.stringify({ id: message.id, error }) + '\n')
  if (message.params?.fixtureDelay === true) setTimeout(send, 50)
  else send()
})
