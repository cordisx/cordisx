import { useEffect, useState } from 'react'
import type { PluginManagementSnapshot } from '../../../management/contracts.js'
import type { PluginManagementBinding } from '../../management-binding.js'

export type ManagerPluginManagementBinding = PluginManagementBinding

export interface ManagerPluginManagementState {
  readonly snapshot: PluginManagementSnapshot | undefined
  readonly loading: boolean
  readonly error: string | undefined
}

export function usePluginManagementSnapshot(
  binding: ManagerPluginManagementBinding | undefined,
  activationRevision?: number,
): ManagerPluginManagementState {
  const [state, setState] = useState<ManagerPluginManagementState>({
    snapshot: undefined,
    loading: binding !== undefined,
    error: undefined,
  })
  useEffect(() => {
    if (binding === undefined) {
      setState({ snapshot: undefined, loading: false, error: undefined })
      return undefined
    }
    let active = true
    setState(current => ({ ...current, loading: current.snapshot === undefined, error: undefined }))
    const receive = (snapshot: PluginManagementSnapshot) => {
      if (active) setState({ snapshot, loading: false, error: undefined })
    }
    const unsubscribe = binding.subscribe(receive)
    void binding.query().then(receive).catch(error => {
      if (active) {
        setState({ snapshot: undefined, loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [binding])
  useEffect(() => {
    if (binding === undefined || activationRevision === undefined) return undefined
    let active = true
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const snapshot = await binding.query()
        if (!active) return
        if (snapshot.activationRevision === activationRevision) {
          setState({ snapshot, loading: false, error: undefined })
          return
        }
      } catch { /* The owner may still be completing a lifecycle handoff. */ }
      if (active && ++attempts < 120) timer = setTimeout(() => void refresh(), 250)
    }
    timer = setTimeout(() => void refresh(), 50)
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [binding, activationRevision])
  return state
}
