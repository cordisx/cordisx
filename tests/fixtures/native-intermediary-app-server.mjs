import { createInterface } from 'node:readline'
const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'fixture/exit') {
    process.exitCode = 7
    reader.close()
    process.stdin.destroy()
    return
  }
  if (message.method === 'echo/bytes') {
    process.stdout.write(`${line}\n`)
    return
  }
  if (message.method === 'thread/resume') {
    process.stdout.write(
      `${
        JSON.stringify({
          id: message.id,
          result: {
            thread: { id: message.params.threadId },
            modelProvider: message.params.modelProvider,
            model: message.params.model,
          },
        })
      }\n`,
    )
    return
  }
  process.stdout.write(
    `${
      JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: 'created-thread',
            ...(message.method === 'thread/read' ? { status: { type: message.params.threadId } } : {}),
          },
          received: message.params,
          method: message.method,
          leakedControlEnvironment: Object.keys(process.env).filter(key =>
            key.startsWith('CORDISX_NATIVE_') || key === 'CODEX_CLI_PATH'
          ),
        },
      })
    }\n`,
  )
})
