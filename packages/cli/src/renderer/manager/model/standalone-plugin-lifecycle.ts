import { createContext } from 'react'
import type { PluginManagementSnapshot } from '../../../management/contracts.js'
import type { ManagerPluginManagementBinding } from './plugin-management.js'

/** The owner projects per-plugin operations only to an independent Manager. */
export const StandalonePluginLifecycleContext = createContext<
  {
    readonly binding: ManagerPluginManagementBinding
    readonly snapshot: PluginManagementSnapshot | undefined
  } | undefined
>(undefined)
