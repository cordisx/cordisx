import path from 'node:path'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import type { UsageSnapshotV1 } from '../usage-contracts.js'
/** Host initial task metadata only. Never infer activity from prompts or task names. */
export function classifyWorkUsageHeader(header: string): 'work' | 'game' | 'unclassified' {
  try {
    const item = JSON.parse(header)
    const p = item?.payload
    if (
      item?.type !== 'session_meta' || p === null || typeof p !== 'object' || Array.isArray(p)
      || typeof p.cwd !== 'string' || !path.isAbsolute(p.cwd)
    ) return 'unclassified'
    if (
      p.forked_from_id != null || p.parent_thread_id != null || p.source === 'subagent'
      || (typeof p.source === 'object' && p.source?.subagent !== undefined)
    ) return 'unclassified'
    const cwd = path.normalize(p.cwd)
    if (
      /\/state\/profiles\/[^/]+\/agent-loop\/game-workspaces\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}(?:\/|$)/u.test(cwd)
    ) return 'game'
    if (!['cli', 'vscode', 'exec', 'mcp'].includes(p.source)) return 'unclassified'
    return 'work'
  } catch {
    return 'unclassified'
  }
}
export function projectWorkUsage(snapshot: UsageSnapshotV1): WorkUsageSnapshotV2 {
  if (snapshot.status !== 'ready') return { ...snapshot, schemaVersion: 2 }
  return {
    ...snapshot,
    schemaVersion: 2,
    policyId: 'codex-local-work-input-output-v2',
    sourceId: 'codex-local-work-rollouts-v2',
    classification: {
      version: 'host-game-cwd-v1',
      hostGameTasks: 'excluded',
      forksAndSubagents: 'excluded',
      unknownSources: 'excluded',
    },
  }
}
