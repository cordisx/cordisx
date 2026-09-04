import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'

export const inject = ['pages', 'routes']

export function apply(ctx: Context): void {
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'room',
    title: { key: 'fixture.room.title', fallback: 'Room' },
    description: { key: 'fixture.room.description', fallback: 'Agent Session route owner fixture.' },
  }, () => () => undefined)
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'room-session-detail',
    path: '/main/chatroom/:roomId/session/:sessionId',
    outlet: 'main',
    page: 'room',
    title: { key: 'fixture.session.title', fallback: 'Open session' },
    description: { key: 'fixture.session.description', fallback: 'Open the exact Room Agent Session.' },
  })
}
