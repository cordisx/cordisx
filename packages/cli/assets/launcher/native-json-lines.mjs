/** Accumulate each JSONL frame once. Model data has no Host byte cap by default. */
export function readNativeLines(stream, receive, reject, maxBytes) {
  let fragments = []
  let bytes = 0
  let rejected = false
  const fail = reason => {
    if (rejected) return
    rejected = true
    fragments = []
    bytes = 0
    reject(reason)
  }
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    if (rejected) return
    let start = 0
    for (;;) {
      const newline = chunk.indexOf('\n', start)
      const fragment = chunk.slice(start, newline < 0 ? undefined : newline)
      if (maxBytes !== undefined) {
        bytes += Buffer.byteLength(fragment)
        if (bytes > maxBytes) return fail('frame-limit-exceeded')
      }
      if (fragment.length > 0) fragments.push(fragment)
      if (newline < 0) return
      const line = fragments.length === 1 ? fragments[0] : fragments.join('')
      fragments = []
      bytes = 0
      start = newline + 1
      if (line.length > 0) receive(line)
    }
  })
  stream.once('end', () => {
    if (!rejected && fragments.some(fragment => fragment.trim() !== '')) fail('incomplete-frame')
    fragments = []
  })
  stream.once('close', () => {
    fragments = []
  })
}
