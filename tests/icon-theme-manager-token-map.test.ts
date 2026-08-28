import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MANAGER_ICON_TOKENS } from '../packages/cli/src/renderer/icons.js'

describe('Manager icon token audit table', () => {
  it('covers every current token and the one planned acknowledgements token exactly once', async () => {
    const source = await readFile(new URL('../docs/icon-theme-manager-token-map.md', import.meta.url), 'utf8')
    const rows = [...source.matchAll(/^\| `([^`]+?)(?:` \(planned Host token\)|`) \|/gmu)].map(match => match[1]!)
    expect([...rows].sort()).toEqual([...MANAGER_ICON_TOKENS, 'acknowledgements'].sort())
    expect(new Set(rows).size).toBe(rows.length)
  })

  it('records all 13 API-blocked target semantics without pretending they are current', async () => {
    const source = await readFile(new URL('../docs/icon-theme-manager-token-map.md', import.meta.url), 'utf8')
    const targets = [
      'action.move', 'action.export', 'action.follow', 'action.pause', 'action.resume',
      'action.favorite', 'action.import', 'action.enable', 'action.disable', 'action.submit',
      'content.contributions', 'content.acknowledgements', 'agent.turn-control',
    ]
    for (const semantic of targets) expect(source).toContain(`| \`${semantic}\` |`)
    expect(source.match(/wait for formal 64-key API/g)).toHaveLength(13)
  })
})
