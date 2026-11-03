import { PassThrough } from 'node:stream'

export let nativeInput = process.stdin

/** Native browser helpers also start without plugin overrides; client identity selects this query channel. */
export async function isComputerUseHelper(args) {
  const replay = new PassThrough()
  replay.once('close', () => process.stdin.destroy())
  nativeInput = replay
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const finish = () => {
      process.stdin.off('data', receive)
      process.stdin.off('end', end)
      process.stdin.off('error', fail)
    }
    const fail = error => {
      finish()
      reject(error)
    }
    const end = () => {
      finish()
      replay.end(buffer)
      resolve(false)
    }
    const receive = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const newline = buffer.indexOf(10)
      if (newline < 0 && buffer.length <= 8 * 1024 * 1024) return
      process.stdin.pause()
      finish()
      if (newline < 0 || newline > 8 * 1024 * 1024) {
        reject(new Error('Native initialize frame exceeds limit'))
        return
      }
      let helper = false
      try {
        const first = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
        helper = first.method === 'initialize'
          && ['codex-computer-use', 'codex-browser-use'].includes(first.params?.clientInfo?.name)
      } catch {}
      replay.write(buffer)
      process.stdin.pipe(replay)
      resolve(helper)
    }
    process.stdin.on('data', receive)
    process.stdin.once('end', end)
    process.stdin.once('error', fail)
  })
}
