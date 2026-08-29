import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../packages/cli/src/contracts.js'

export const name = 'Icon Theme Provider Fixture'
export const inject = ['iconThemes']

export function apply(ctx: Context): void {
  ctx.iconThemes.register({
    schemaVersion: 1,
    namespace: 'aurora',
    providerVersion: '2.1.0',
    descriptors: [{
      key: 'action.save',
      variant: 'regular',
      state: 'default',
      descriptor: {
        format: 'cordisx.normalized-vector',
        formatVersion: 1,
        viewBox: { minX: 0, minY: 0, width: 24, height: 24 },
        paths: [{
          paint: 'stroke',
          strokeWidth: 1.5,
          lineCap: 'round',
          lineJoin: 'round',
          commands: [{ op: 'move', x: 3, y: 12 }, { op: 'line', x: 21, y: 12 }],
        }],
      },
    }],
  })
}
