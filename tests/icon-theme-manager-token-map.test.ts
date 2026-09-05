import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { MANAGER_ICON_SEMANTICS, MANAGER_ICON_TOKENS } from '../packages/cli/src/renderer/icons.js'

describe('Manager icon token audit table', () => {
  it('covers every current token exactly once', async () => {
    const source = await readFile(new URL('../.agents/docs/icon-theme-manager-token-map.md', import.meta.url), 'utf8')
    const rows = [...source.matchAll(/^\|[ \t]+`([^`]+?)`[ \t]+\|/gmu)].map(match => match[1]!)
    expect([...rows].sort()).toEqual([...MANAGER_ICON_TOKENS].sort())
    expect(new Set(rows).size).toBe(rows.length)
  })

  it('records all 13 formally mapped semantics as current', async () => {
    const source = await readFile(new URL('../.agents/docs/icon-theme-manager-token-map.md', import.meta.url), 'utf8')
    const targets = [
      'action.move',
      'action.export',
      'action.follow',
      'action.pause',
      'action.resume',
      'action.favorite',
      'action.import',
      'action.enable',
      'action.disable',
      'action.submit',
      'content.contributions',
      'content.acknowledgements',
      'agent.turn-control',
    ]
    const rows = source.split('\n').map(row => row.split('|').slice(1, -1).map(cell => cell.trim()))
    for (const semantic of targets) {
      expect(rows.some(row => row.some((name, index) => name === `\`${semantic}\`` && row[index + 1] === 'same'))).toBe(
        true,
      )
    }
    expect(source).not.toContain('wait for formal 64-key API')
    expect({
      move: MANAGER_ICON_SEMANTICS.move,
      'console-export': MANAGER_ICON_SEMANTICS['console-export'],
      'console-follow': MANAGER_ICON_SEMANTICS['console-follow'],
      'console-pause': MANAGER_ICON_SEMANTICS['console-pause'],
      'console-resume': MANAGER_ICON_SEMANTICS['console-resume'],
      contributions: MANAGER_ICON_SEMANTICS.contributions,
      acknowledgements: MANAGER_ICON_SEMANTICS.acknowledgements,
      'turns-control': MANAGER_ICON_SEMANTICS['turns-control'],
      'turns-submit': MANAGER_ICON_SEMANTICS['turns-submit'],
      'disable-plugin': MANAGER_ICON_SEMANTICS['disable-plugin'],
      'enable-plugin': MANAGER_ICON_SEMANTICS['enable-plugin'],
      favorite: MANAGER_ICON_SEMANTICS.favorite,
      'favorite-active': MANAGER_ICON_SEMANTICS['favorite-active'],
      'import-plugin': MANAGER_ICON_SEMANTICS['import-plugin'],
    }).toEqual({
      move: 'action.move',
      'console-export': 'action.export',
      'console-follow': 'action.follow',
      'console-pause': 'action.pause',
      'console-resume': 'action.resume',
      contributions: 'content.contributions',
      acknowledgements: 'content.acknowledgements',
      'turns-control': 'agent.turn-control',
      'turns-submit': 'action.submit',
      'disable-plugin': 'action.disable',
      'enable-plugin': 'action.enable',
      favorite: 'action.favorite',
      'favorite-active': 'action.favorite',
      'import-plugin': 'action.import',
    })
  })
})
