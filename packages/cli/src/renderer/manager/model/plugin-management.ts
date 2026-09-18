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
  return state
}
