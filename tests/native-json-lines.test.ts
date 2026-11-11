import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readNativeLines } from '../packages/cli/assets/launcher/native-json-lines.mjs'

describe('native JSONL fragment framing', () => {
  it('assembles split UTF-8 data and successive frames without counting a whole chunk as one frame', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const rejected: string[] = []
    readNativeLines(stream, (line: string) => lines.push(line), (reason: string) => rejected.push(reason), 6)
    const data = Buffer.from('你a\nnext\n')
    stream.write(data.subarray(0, 1))
    stream.write(data.subarray(1, 5))
    stream.write(data.subarray(5))
    expect(lines).toEqual(['你a', 'next'])
    expect(rejected).toEqual([])
    stream.end()
  })

  it('rejects only an explicitly bounded channel and clears a rejected partial frame', () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const rejected: string[] = []
    readNativeLines(stream, (line: string) => lines.push(line), (reason: string) => rejected.push(reason), 4)
    stream.write('abcd')
    stream.write('e')
    stream.write('later\n')
    expect(lines).toEqual([])
    expect(rejected).toEqual(['frame-limit-exceeded'])
    stream.end()
  })
})
