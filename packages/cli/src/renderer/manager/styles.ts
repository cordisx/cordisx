import { PLUGIN_CONSOLE_REACT_STYLES } from './components/PluginConsolePanel.js'
import { HOST_FORM_REACT_STYLES } from '../host-ui/HostForm.js'
import { HOST_COLLECTION_STYLES } from '../host-collection.js'
import { HOST_ICON_16PX_CSS } from '../icons.js'
import tdesignReactCss from 'tdesign-react/dist/tdesign.css'

const scopedTDesignReactCss = tdesignReactCss.replace(
  ":root.dark,\n:root[theme-mode='dark']",
  ".cxr-root[data-cordisx-app-theme='dark']",
)

export const REACT_MANAGER_STYLES = `${scopedTDesignReactCss}\n${HOST_ICON_16PX_CSS}\n${String.raw`
  .cxr-root { position: relative; z-index: 2147483500; color: var(--cx-text, #edf0f4); font: 13px/1.45 system-ui, sans-serif; }
  .cxr-root *, .cxr-root *::before, .cxr-root *::after { box-sizing: border-box; }
  .cxr-root :is(.t-popup,.t-dialog__ctx) { z-index: 2147483600 !important; }
  .cxr-brand-mark { display: inline-grid; width: 18px; height: 18px; flex: none; place-items: center; }
  .cxr-brand-mark > img, .cxr-brand-mark > svg { display: block; grid-area: 1 / 1; width: 100%; height: 100%; border: 0; background: transparent; object-fit: contain; pointer-events: none; }
  .cxr-brand-mark > .cxr-brand-mark-light { display: none; }
  [data-cordisx-app-theme="light"] .cxr-brand-mark > .cxr-brand-mark-dark { display: none; }
  [data-cordisx-app-theme="light"] .cxr-brand-mark > .cxr-brand-mark-light { display: block; }
  .cxr-trigger { display: inline-flex; width: 32px; height: 32px; align-items: center; justify-content: center; margin-left: 2px; border: 0; border-radius: 9px; padding: 0; background: transparent; color: inherit; cursor: pointer; opacity: .72; }
  .cxr-trigger:hover, .cxr-trigger[aria-expanded="true"] { background: var(--cx-hover, color-mix(in srgb,currentColor 9%,transparent)); opacity: 1; }
  .cxr-trigger:focus-visible { outline: 2px solid var(--cx-focus, #c7ccd4); outline-offset: 1px; }
  .cxr-trigger > .cxr-trigger-mark { width: 20px; height: 20px; }
  .cxr-backdrop { position: fixed; inset: 0; z-index: 2147483500; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 58%); }
  .cxr-dialog { display: grid; width: min(1236px, calc(100vw - 40px)); height: min(860px, calc(100vh - 40px)); overflow: hidden; grid-template-columns: 264px minmax(0,1fr); border: 1px solid var(--cx-border, #353a42); border-radius: 18px; background: var(--cx-surface, #17191d); box-shadow: 0 30px 100px rgb(0 0 0 / 50%); }
  .cxr-sidebar { display: flex; min-height: 0; flex-direction: column; padding: 12px; border-right: 1px solid var(--cx-border, #353a42); background: var(--cx-surface-raised, #20242b); }
  .cxr-nav { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 3px; }
  .cxr-nav-spacer { flex: 1; }
  .cxr-nav button { display: grid; min-height: 40px; grid-template-columns: 28px minmax(0,1fr); align-items: center; gap: 7px; border: 0; border-radius: 9px; padding: 5px 9px; background: transparent; color: var(--cx-muted, #aab2c0); cursor: pointer; text-align: left; font: inherit; }
  .cxr-nav button:hover, .cxr-nav button[aria-current="page"] { background: var(--cx-hover, rgba(255,255,255,.08)); color: var(--cx-text, #edf0f4); }
  .cxr-nav button:focus-visible { outline: 2px solid var(--cx-focus, #8aa8ff); outline-offset: 1px; }
  .cxr-nav .cxh-icon-seat, .cxr-nav .cxm-host-icon { display: grid; width: 18px; height: 18px; place-items: center; }
  .cxr-nav button > :first-child { display: grid; width: 18px; height: 18px; align-self: center; justify-self: center; place-items: center; line-height: 1; }
  .cxr-main { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0,1fr); }
  .cxr-header { display: grid; grid-template-columns: 32px minmax(0,1fr) 32px; align-items: center; gap: 8px; padding: 10px 18px; border-bottom: 1px solid var(--cx-border, #353a42); }
  .cxr-header-seat { display: grid; width: 32px; height: 32px; place-items: center; }
  .cxr-header > .t-button, .cxr-header-seat > .t-button { width: 32px; height: 32px; padding: 0; }
  .cxr-header-seat > :is(.t-icon,.cordisx-host-icon), .cxr-header > .t-button :is(.t-icon,.cordisx-host-icon), .cxr-header-seat > .t-button :is(.t-icon,.cordisx-host-icon) { width: 16px; height: 16px; color: var(--cx-muted, #aab2c0); font-size: 16px !important; }
  .cxr-header-seat > .cxr-brand-mark { width: 18px; height: 18px; }
  .cxr-heading { min-width: 0; }
  .cxr-heading h2 { margin: 0; overflow: hidden; color: var(--cx-text, #edf0f4); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-breadcrumbs { display: flex; min-width: 0; align-items: center; gap: 7px; overflow: hidden; color: var(--cx-muted, #9ca5b5); font-size: 14px; white-space: nowrap; }
  .cxr-breadcrumbs button { min-width: 0; overflow: hidden; border: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-breadcrumbs button:hover { color: var(--cx-text, #edf0f4); }
  .cxr-breadcrumbs [aria-current="page"] { min-width: 0; overflow: hidden; color: var(--cx-text, #edf0f4); font-weight: 650; text-overflow: ellipsis; }
  .cxr-content { min-width: 0; min-height: 0; overflow: auto; padding: 16px 22px 22px; }
  .cxr-content:has(.cxr-plugin-config-panel) { overflow: hidden; padding-bottom: 0; }
  .cxr-content:has(.cxm-console-panel) { display: flex; overflow: hidden; }
  .cxr-content:has(.cxm-console-panel) > * { min-height: 0; flex: 1; }
  .cxr-page { width: 100%; min-width: 0; }
  .cxr-content .cxr-react-root { min-height: 0; padding: 0; }
  .cxr-page:has(> .cxm-console-panel) { display: flex; min-height: 0; flex-direction: column; overflow: hidden; }
  .cxr-page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
  .cxr-page-head h3 { margin: 0; font-size: 16px; }
  .cxr-page-head p { margin: 4px 0 0; color: var(--cx-muted, #9ca5b5); font-size: 11px; }
  .cxh-search-field { display: flex; min-width: 0; align-items: center; }
  .cxh-search-icon { display: grid; width: 18px; height: 18px; flex: none; place-items: center; color: var(--cx-muted, #9ca5b5); }
  .cxh-search-icon svg { display: block; width: 16px; height: 16px; }
  .cxh-search-field input { min-width: 0; border: 0; outline: 0; padding: 0; background: transparent; color: inherit; font: inherit; }
  .cxr-search { width: 100%; height: 34px; gap: 8px; box-sizing: border-box; border: 1px solid var(--cx-border, #353a42); border-radius: 8px; padding: 0 10px; background: var(--cx-surface-raised,#20242b); color: inherit; }
  .cxr-search:focus-within { border-color: var(--cx-primary, #2f7cff); outline: 2px solid var(--cx-focus, rgba(47,124,255,.26)); outline-offset: 1px; }
  .cxr-search input { width: 100%; height: 32px; }
  .cxr-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); align-items: stretch; gap: 7px; margin-top: 12px; }
  .cxr-card { display: flex; min-width: 0; align-items: center; gap: 11px; width: 100%; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; padding: 11px 12px; background: var(--cx-surface-raised,#20242b); color: inherit; text-align: left; font: inherit; }
  button.cxr-card { cursor: pointer; }
  button.cxr-card:hover { border-color: color-mix(in srgb, var(--cx-text,#fff) 30%, var(--cx-border,#353a42)); background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-card-icon { position: relative; display: grid; width: 34px; height: 34px; flex: none; place-items: center; border-radius: 9px; background: var(--cx-hover,rgba(255,255,255,.08)); color: var(--cx-muted,#aab2c0); font-weight: 700; }
  .cxr-card-icon > img { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: contain; }
  .cxr-card-icon[data-icon-kind="artwork"], .cxr-card-icon:has(> .cxr-plugin-badge) { background: transparent; }
  .cxr-plugin-badge { display: grid; width: 100%; height: 100%; overflow: hidden; place-items: center; border-radius: inherit; background: transparent; }
  .cxr-plugin-badge > img { display: block; grid-area: 1 / 1; width: 100%; height: 100%; border: 0; background: transparent; object-fit: contain; pointer-events: none; }
  .cxr-plugin-badge > .cxr-plugin-badge-light { display: none; }
  .cxr-root[data-cordisx-app-theme="light"] .cxr-plugin-badge > .cxr-plugin-badge-dark { display: none; }
  .cxr-root[data-cordisx-app-theme="light"] .cxr-plugin-badge > .cxr-plugin-badge-light { display: block; }
  .cxr-status-dot { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border: 2px solid var(--cx-surface-raised,#20242b); border-radius: 50%; background: var(--cx-muted,#8b95a5); }
  .cxr-status-dot[data-status="active"] { background: var(--cx-success,#4dc78f); }
  .cxr-status-dot[data-status="failed"], .cxr-status-dot[data-status="rollback-failed"] { background: var(--cx-danger,#f36d7d); }
  .cxr-status-dot[data-status="blocked"], .cxr-status-dot[data-status="permission-blocked"] { background: var(--cx-warning,#e7b75b); }
  .cxr-card-body { min-width: 0; flex: 1; }
  .cxr-card-title { display: block; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-badge { display: inline-flex; align-items: center; margin-left: 7px; border-radius: 999px; padding: 1px 6px; background: color-mix(in srgb,var(--cx-primary,#7da2ff) 16%,transparent); color: var(--cx-primary,#7da2ff); font-size: 9px; font-weight: 600; vertical-align: middle; }
  .cxr-card-description { display: block; margin-top: 3px; overflow: hidden; color: var(--cx-muted,#9ca5b5); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-card-code { display: block; margin-top: 4px; overflow: hidden; color: var(--cx-muted,#7f899a); font: 10px/1.3 ui-monospace,monospace; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-local-development-source { display: flex; align-items: center; gap: 12px; padding: 11px 13px; border: 1px solid var(--cx-border,#353a42); border-radius: 10px; background: var(--cx-surface-raised,#20242b); }
  .cxr-local-development-source > strong { color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxr-local-development-source[data-development-state="failed"] > strong, .cxr-local-development-error { color: var(--cx-danger,#f59aa4); }
  .cxr-local-development-error { display: block; margin-top: 6px; overflow-wrap: anywhere; font-size: 11px; }
  .cxr-status { flex: none; color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxr-status[data-tone="danger"] { color: var(--cx-danger,#f59aa4); }
  .cxr-plugin-row { position: relative; display: flex; min-width: 0; min-height: 78px; align-items: center; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-plugin-row:hover, .cxr-plugin-row:focus-within { border-color: color-mix(in srgb, var(--cx-text,#fff) 30%, var(--cx-border,#353a42)); background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-plugin-primary { display: flex; min-width: 0; flex: 1; align-items: center; gap: 11px; border: 0; padding: 11px 12px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
  .cxr-plugin-actions { position: absolute; top: 50%; right: 8px; z-index: 1; display: flex; align-items: center; gap: 2px; border-radius: 8px; padding: 2px; background: color-mix(in srgb,var(--cx-surface-raised,#20242b) 92%,transparent); box-shadow: 0 2px 12px rgb(0 0 0 / 20%); opacity: 0; pointer-events: none; transform: translateY(-50%); transition: opacity 120ms ease; }
  .cxr-plugin-row:hover .cxr-plugin-actions, .cxr-plugin-row:focus-within .cxr-plugin-actions { opacity: 1; pointer-events: auto; }
  .cxr-tabs { display: flex; min-height: 38px; flex: none; gap: 2px; overflow-x: auto; margin: -5px 0 12px; border-bottom: 1px solid var(--cx-border,#353a42); }
  .cxr-tabs button { display: inline-flex; height: 38px; flex: none; align-items: center; gap: 6px; border: 0; border-bottom: 2px solid transparent; padding: 0 9px; background: transparent; color: var(--cx-muted,#9ca5b5); cursor: pointer; }
  .cxr-tabs button :is(.t-icon,.cordisx-host-icon) { width: 15px; height: 15px; font-size: 15px; }
  .cxr-tabs button[aria-selected="true"] { border-bottom-color: var(--cx-primary,#7da2ff); color: var(--cx-text,#edf0f4); }
  .cxr-empty, .cxr-notice { grid-column: 1 / -1; padding: 18px; border: 1px dashed var(--cx-border,#353a42); border-radius: 10px; color: var(--cx-muted,#9ca5b5); text-align: center; }
  .cxr-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
  .cxr-section { padding: 13px; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-section h3, .cxr-section h4 { margin: 0; }
  .cxr-section p { margin: 5px 0 0; color: var(--cx-muted,#9ca5b5); }
  .cxr-facts { display: grid; gap: 7px; margin: 10px 0 0; }
  .cxr-facts > div { display: grid; grid-template-columns: 76px minmax(0,1fr); gap: 9px; }
  .cxr-facts dt { color: var(--cx-muted,#9ca5b5); }
  .cxr-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .cxr-item-full { grid-column: 1 / -1; }
  .cxr-danger { color: var(--cx-danger,#f59aa4) !important; }
  .cxr-policy-select { width: min(180px, 35%); flex: none; }
  .cxr-dialog-form { display: grid; gap: 12px; }
  .cxr-dialog-form label { display: grid; gap: 5px; }
  .cxr-marketplace-tools { display: flex; min-width: 0; align-items: center; overflow: hidden; border: 1px solid var(--cx-border,#353a42); border-radius: 9px; background: var(--cx-surface-raised,#20242b); }
  .cxr-marketplace-search { min-width: 0; flex: 1; }
  .cxr-marketplace-search .t-input { border: 0; border-radius: 0; box-shadow: none; }
  .cxr-marketplace-tool-actions { display: flex; flex: none; align-items: center; gap: 1px; border-left: 1px solid var(--cx-border,#353a42); padding: 2px; }
  .cxr-marketplace-tool-actions .t-button { width: 30px; height: 30px; }
  .cxr-marketplace-filter[aria-pressed="true"] { background: var(--cx-pressed,rgba(255,255,255,.12)); color: var(--cx-primary,#7da2ff); }
  .cxr-marketplace-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(min(100%,280px),1fr)); gap: 9px; margin-top: 12px; }
  .cxr-marketplace-card { position: relative; display: flex; min-width: 0; min-height: 96px; align-items: center; border: 1px solid var(--cx-border); border-radius: 11px; background: var(--cx-surface-raised); color: inherit; }
  .cxr-marketplace-card:hover { border-color: color-mix(in srgb,var(--cx-text) 32%,var(--cx-border)); }
  .cxr-marketplace-primary { display: flex; min-width: 0; min-height: 94px; flex: 1; align-items: center; gap: 11px; border: 0; padding: 13px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
  .cxr-marketplace-actions { position: absolute; top: 50%; right: 8px; z-index: 1; display: flex; align-items: center; gap: 2px; border-radius: 8px; padding: 2px; background: color-mix(in srgb,var(--cx-surface-raised,#20242b) 92%,transparent); box-shadow: 0 2px 12px rgb(0 0 0 / 20%); opacity: 0; pointer-events: none; transform: translateY(-50%); transition: opacity 120ms ease; }
  .cxr-marketplace-card:hover .cxr-marketplace-actions, .cxr-marketplace-card:focus-within .cxr-marketplace-actions { opacity: 1; pointer-events: auto; }
  .cxr-marketplace-meta { align-self: end; color: var(--cx-muted); font-size: 10px; }
  .cxr-marketplace-title-row { display: flex; min-width: 0; align-items: center; gap: 6px; }
  .cxr-marketplace-title-row > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-marketplace-trust-badges { display: inline-flex; flex: none; align-items: center; gap: 4px; }
  .cxr-marketplace-trust-badge { display: inline-flex; align-items: center; gap: 3px; border: 1px solid var(--cx-border,#353a42); border-radius: 999px; padding: 2px 5px; background: var(--cx-hover,rgba(255,255,255,.06)); font-size: 9px; font-weight: 700; line-height: 1.2; white-space: nowrap; }
  .cxr-marketplace-trust-badge[data-trust-dimension="official"] { color: color-mix(in srgb,var(--cx-primary,#7da2ff) 78%,var(--cx-text,#edf0f4)); }
  .cxr-marketplace-trust-badge[data-trust-dimension="certified"] { color: var(--cx-success,#4ade80); }
  .cxr-marketplace-trust-badge .cordisx-host-icon { width: 12px; height: 12px; }
  .cxr-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; margin-top: 12px; }
  .cxr-button { min-height: 32px; border: 1px solid var(--cx-border,#353a42); border-radius: 8px; padding: 5px 10px; background: var(--cx-hover,rgba(255,255,255,.06)); color: inherit; cursor: pointer; }
  .cxr-button:disabled { opacity: .4; cursor: default; }
  .cxr-button[data-tone="danger"] { color: var(--cx-danger,#f59aa4); }
  .cxr-markdown { width: 100%; max-width: none; min-width: 0; margin: 0; color: var(--cx-text,#edf0f4); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
  .cxr-markdown > :first-child { margin-top: 0; }
  .cxr-markdown > :last-child { margin-bottom: 0; }
  .cxr-markdown h1, .cxr-markdown h2, .cxr-markdown h3, .cxr-markdown h4 { margin: 1.55em 0 .65em; line-height: 1.3; }
  .cxr-markdown h1 { padding-bottom: .35em; border-bottom: 1px solid var(--cx-border,#353a42); font-size: 22px; }
  .cxr-markdown h2 { padding-bottom: .3em; border-bottom: 1px solid var(--cx-border,#353a42); font-size: 18px; }
  .cxr-markdown h3 { font-size: 15px; }
  .cxr-markdown p, .cxr-markdown ul, .cxr-markdown ol, .cxr-markdown blockquote, .cxr-markdown pre, .cxr-markdown table { margin: 0 0 1em; }
  .cxr-markdown ul, .cxr-markdown ol { padding-left: 1.65em; }
  .cxr-markdown li + li { margin-top: .3em; }
  .cxr-markdown a { color: var(--cx-primary,#7da2ff); text-decoration-thickness: 1px; text-underline-offset: 2px; }
  .cxr-markdown code { border-radius: 5px; padding: .15em .35em; background: var(--cx-hover,rgba(255,255,255,.07)); font: .9em/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .cxr-markdown pre { max-width: 100%; overflow: auto; border: 1px solid var(--cx-border,#353a42); border-radius: 9px; padding: 12px; background: var(--cx-surface-raised,#20242b); }
  .cxr-markdown pre code { padding: 0; background: transparent; color: inherit; white-space: pre; }
  .cxr-markdown pre code[data-shiki-theme] { display: block; }
  .cxr-markdown .cxm-readme-code-line { display: block; min-height: 1.45em; }
  .cxr-markdown blockquote { border-left: 3px solid var(--cx-border,#353a42); padding-left: 12px; color: var(--cx-muted,#9ca5b5); }
  .cxr-markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
  .cxr-markdown th, .cxr-markdown td { border: 1px solid var(--cx-border,#353a42); padding: 6px 9px; text-align: left; }
  .cxr-markdown picture { display: block; max-width: 100%; margin: 0 0 1em; }
  .cxr-markdown img, .cxr-markdown video { display: block; max-width: 100%; height: auto; border-radius: 9px; background: var(--cx-surface-raised,#20242b); }
  .cxr-markdown picture > img { margin: 0 auto; }
  .cxr-markdown video { width: 100%; }
  .cxr-readable-code { font: 11px/1.5 ui-monospace,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .cxr-plugin-identity { display: flex; min-width: 0; align-items: center; gap: 14px; margin-bottom: 10px; padding: 4px 0 12px; }
  .cxr-plugin-identity .cxr-card-icon { width: 52px; height: 52px; border-radius: 12px; }
  .cxr-plugin-identity-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
  .cxr-plugin-identity-copy strong { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-plugin-identity-meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px 10px; color: var(--cx-muted,#9ca5b5); font-size: 10px; }
  .cxr-plugin-identity-meta a { color: inherit; }
  .cxr-plugin-identity-description { display: -webkit-box; overflow: hidden; color: var(--cx-muted,#9ca5b5); font-size: 11px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxr-plugin-identity-actions { display: flex; flex: none; align-items: center; gap: 6px; }
  .cxr-plugin-identity-actions .t-button { width: 34px; height: 34px; flex: none; padding: 0; }
  .cxr-marketplace-identity .cxr-card-icon img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
  .cxr-marketplace-trust-details { display: grid; gap: 10px; margin: 0 0 14px; border-top: 1px solid var(--cx-border,#353a42); border-bottom: 1px solid var(--cx-border,#353a42); padding: 12px 0; }
  .cxr-marketplace-trust-details > div { min-width: 0; }
  .cxr-marketplace-trust-details h3 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; }
  .cxr-marketplace-trust-details h3 .cordisx-host-icon { width: 16px; height: 16px; }
  .cxr-marketplace-trust-details p { margin: 5px 0 0; color: var(--cx-muted,#9ca5b5); font-size: 11px; line-height: 1.5; }
  .cxr-marketplace-trust-details code { overflow-wrap: anywhere; }
  .cxr-marketplace-trust-details a { display: inline-flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--cx-primary,#7da2ff); font-size: 11px; }
  .cxr-marketplace-trust-details a .cordisx-host-icon { width: 13px; height: 13px; }
  .cxr-marketplace-trust-record-label { color: var(--cx-text,#edf0f4); font-weight: 650; }
  .cxr-permission-list { grid-template-columns: minmax(0,1fr); }
  .cxr-permission-summary { cursor: default; }
  .cxr-permission-summary .cxr-card-description { overflow: visible; text-overflow: clip; white-space: normal; }
  .cxr-marketplace-detail-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(min(260px,100%),1fr)); align-items: stretch; gap: 9px; }
  .cxr-marketplace-detail-grid > .cxr-metric { border-radius: 11px; }
  .cxr-marketplace-source-link { text-decoration: none; }
  .cxr-marketplace-source-link > :is(.t-icon,.cordisx-host-icon) { flex: none; color: var(--cx-muted,#9ca5b5); }
  .cxr-page[data-plugin-detail]:has(> .cxr-plugin-config-panel) { display: flex; height: 100%; min-height: 0; flex-direction: column; }
  .cxr-plugin-config-panel { display: flex; min-height: 0; flex: 1; flex-direction: column; }
  .cxr-plugin-config-panel > .cxf-react-form-shell { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden; }
  .cxr-plugin-config-panel .cxf-react-form { min-height: 0; flex: 1; overflow: hidden; }
  .cxr-plugin-config-panel .cxf-form-body { min-height: 0; flex: 1; overflow: auto; }
  .cxr-plugin-config-panel .cxf-form-actions { flex: none; margin: 0 -22px; border-top: 1px solid var(--cx-border,#353a42); padding: 12px 22px; background: var(--cx-surface,#17191d); }
  .cxr-metrics { display: grid; grid-template-columns: repeat(auto-fit,minmax(120px,1fr)); gap: 8px; }
  .cxr-metric { display: grid; gap: 4px; border: 1px solid var(--cx-border,#353a42); border-radius: 10px; padding: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-metric span { color: var(--cx-muted,#9ca5b5); font-size: 10px; }
  .cxr-metric strong { font-size: 17px; }
  .cxr-token-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .cxr-token-list code { border-radius: 6px; padding: 4px 7px; background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-about-identity { display: flex; align-items: center; flex-direction: column; justify-content: center; gap: 12px; margin: 8px 0 26px; text-align: center; }
  .cxr-about-identity > .cxr-brand-mark { width: 128px; height: 128px; }
  .cxr-about-identity > .cxr-brand-mark-animated { overflow: visible; }
  .cxr-about-copy { display: grid; justify-items: center; gap: 2px; }
  .cxr-about-identity strong { margin-bottom: 7px; font-size: 22px; line-height: 1.2; }
  .cxr-about-identity span { color: var(--cx-muted,#9ca5b5); font-size: 12px; }
  .cxr-about-copyright { margin-top: 9px; }
  .cxr-about-links { width: 100%; max-width: none; }
  .cxr-about-links > a { text-decoration: none; }
  .cxr-about-links > :is(a,button) > :is(.t-icon,.cordisx-host-icon) { flex: none; color: var(--cx-muted,#9ca5b5); font-size: 15px; }
  .cxr-card-arrow { flex: none; color: var(--cx-muted,#9ca5b5); font-size: 22px; line-height: 1; }
  .cxr-acknowledgements { display: grid; gap: 28px; }
  .cxr-ack-section > header h3 { margin: 0; font-size: 16px; }
  .cxr-ack-section > header p { max-width: 760px; margin: 4px 0 0; color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxr-ack-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr)); gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
  .cxr-tool-grid { grid-template-columns: repeat(auto-fill, 72px); gap: 14px; }
  .cxr-tool-grid > li { width: 72px; height: 72px; }
  .cxr-tool-icon { display: grid; width: 72px; height: 72px; place-items: center; border: 1px solid var(--cx-border,#353a42); border-radius: 16px; background: var(--cx-surface-raised,#20242b); color: inherit; text-decoration: none; }
  .cxr-tool-icon:hover { border-color: color-mix(in srgb, var(--cx-text,#fff) 30%, var(--cx-border,#353a42)); background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-tool-icon:focus-visible, a.cxr-ack-card:focus-visible { outline: 2px solid var(--cx-accent,#4c8dff); outline-offset: 2px; }
  .cxr-tool-icon img { display: block; width: 48px; height: 48px; object-fit: contain; border-radius: 12px; }
  .cxr-ack-card { box-sizing: border-box; display: flex; width: 100%; min-width: 0; min-height: 88px; align-items: center; gap: 12px; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; padding: 12px; background: var(--cx-surface-raised,#20242b); color: inherit; text-decoration: none; }
  a.cxr-ack-card:hover { border-color: color-mix(in srgb, var(--cx-text,#fff) 30%, var(--cx-border,#353a42)); background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-ack-card > :is(.t-icon,.cordisx-host-icon) { width: 15px; height: 15px; flex: 0 0 15px; color: var(--cx-muted,#9ca5b5); font-size: 15px; }
  .cxr-ack-avatar { display: grid; width: 44px; height: 44px; flex: none; overflow: hidden; place-items: center; border-radius: 12px; background: var(--cx-hover,rgba(255,255,255,.08)); color: var(--cx-muted,#aab2c0); font-weight: 750; letter-spacing: .02em; }
  .cxr-ack-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .cxr-ack-card-body { display: grid; min-width: 0; flex: 1; gap: 3px; }
  .cxr-ack-card-body strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-ack-card-body span { display: -webkit-box; overflow: hidden; color: var(--cx-muted,#9ca5b5); font-size: 11px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .cxr-ack-card-body code { color: var(--cx-muted,#7f899a); font: 10px/1.3 ui-monospace,monospace; }
  .cxr-contributor-grid .cxr-ack-card { min-height: 70px; }
  .cxr-contributor-grid .cxr-ack-avatar { border-radius: 50%; }
  .cxr-license-grid .cxr-ack-card { min-height: 104px; }
  .cxr-ack-empty { margin-top: 12px; }
  [data-cordisx-manager-page] { display: grid; min-width: 0; min-height: 100%; grid-template-rows: auto minmax(0,1fr); }
  [data-cordisx-manager-collection-root]:empty { display: none; }
  [data-cordisx-manager-page-body] { min-width: 0; min-height: 0; }
  .cxr-manager-collection { position: relative; display: grid; min-width: 0; gap: 12px; }
  .cxr-manager-collection-views { display: flex; width: fit-content; max-width: 100%; gap: 3px; border-radius: 9px; padding: 3px; background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-manager-collection-views button { border: 0; border-radius: 7px; padding: 5px 10px; background: transparent; color: var(--cx-muted,#9ca5b5); font: inherit; cursor: pointer; }
  .cxr-manager-collection-views button[aria-selected="true"] { background: var(--cx-surface-raised,#20242b); color: var(--cx-text,#edf0f4); box-shadow: 0 1px 4px rgb(0 0 0 / 18%); }
  .cxr-manager-collection-views button:focus-visible { outline: 2px solid var(--cx-focus,#8aa8ff); outline-offset: 1px; }
  .cxr-manager-collection-search { display: grid; min-width: 0; grid-template-columns: 18px minmax(0,1fr) auto; align-items: center; gap: 7px; border: 1px solid var(--cx-border,#353a42); border-radius: 9px; padding: 7px 9px; background: var(--cx-surface-raised,#20242b); color: var(--cx-muted,#9ca5b5); }
  .cxr-manager-collection-search:focus-within { border-color: var(--cx-focus,#8aa8ff); box-shadow: 0 0 0 1px var(--cx-focus,#8aa8ff); }
  .cxr-manager-collection-search input { min-width: 0; border: 0; outline: 0; padding: 0; background: transparent; color: var(--cx-text,#edf0f4); font: inherit; }
  .cxr-manager-collection-search button, .cxr-manager-collection-action, .cxr-manager-collection-feedback button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 7px; padding: 0; background: transparent; color: var(--cx-muted,#9ca5b5); cursor: pointer; }
  .cxr-manager-collection-search button:hover, .cxr-manager-collection-action:hover:not(:disabled), .cxr-manager-collection-feedback button:hover { background: var(--cx-hover,rgba(255,255,255,.08)); color: var(--cx-text,#edf0f4); }
  .cxr-manager-collection-search button:focus-visible, .cxr-manager-collection-action:focus-visible, .cxr-manager-collection-feedback button:focus-visible { outline: 2px solid var(--cx-focus,#8aa8ff); outline-offset: 1px; }
  .cxr-manager-collection-list { display: grid; min-width: 0; gap: 5px; }
  .cxr-manager-collection-row { position: relative; display: grid; min-width: 0; grid-template-columns: minmax(0,1fr) auto; align-items: center; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-manager-collection-row:hover { border-color: color-mix(in srgb,var(--cx-text,#edf0f4) 22%,var(--cx-border,#353a42)); }
  .cxr-manager-collection-row[data-disabled="true"] { opacity: .62; }
  .cxr-manager-collection-open { display: grid; min-width: 0; grid-template-columns: 38px minmax(0,1fr); align-items: center; gap: 10px; border: 0; border-radius: 10px; padding: 10px 12px; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; }
  .cxr-manager-collection-open:disabled { cursor: default; }
  .cxr-manager-collection-open:focus-visible { outline: 2px solid var(--cx-focus,#8aa8ff); outline-offset: -2px; }
  .cxr-manager-collection-copy { display: grid; min-width: 0; gap: 2px; }
  .cxr-manager-collection-copy strong, .cxr-manager-collection-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-manager-collection-copy span { color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxr-manager-collection-visual { position: relative; display: grid; width: 34px; height: 34px; flex: none; place-items: center; color: var(--cx-muted,#9ca5b5); }
  .cxr-manager-collection-visual > :is(.cordisx-host-icon,.cxm-host-icon) { width: 20px; height: 20px; }
  .cxr-manager-collection-visual .cxa-avatar { display: grid; width: 32px; height: 32px; overflow: hidden; place-items: center; border: 1px solid var(--cx-border,#353a42); border-radius: 50%; background: var(--cx-hover,rgba(255,255,255,.08)); color: var(--cx-text,#edf0f4); font: 700 9px/1 system-ui,sans-serif; }
  .cxr-manager-collection-visual .cxa-avatar-initials, .cxr-manager-collection-visual .cxa-avatar-renderer, .cxr-manager-collection-visual .oneworks-avatar, .cxr-manager-collection-visual .oneworks-avatar svg, .cxr-manager-collection-visual .oneworks-avatar canvas { display: grid; width: 100%; height: 100%; place-items: center; }
  .cxr-manager-collection-avatar-stack > [data-avatar-slot] { position: absolute; display: grid; width: 22px; height: 22px; place-items: center; }
  .cxr-manager-collection-avatar-stack > [data-avatar-slot="0"] { top: 0; left: 0; z-index: 3; }
  .cxr-manager-collection-avatar-stack > [data-avatar-slot="1"] { top: 0; right: 0; z-index: 2; }
  .cxr-manager-collection-avatar-stack > [data-avatar-slot="2"] { bottom: 0; left: 6px; z-index: 1; }
  .cxr-manager-collection-avatar-stack > [data-avatar-slot] .cxa-avatar { width: 22px; height: 22px; border: 2px solid var(--cx-surface-raised,#20242b); font-size: 6px; }
  .cxr-manager-collection-avatar-overflow { position: absolute; right: -2px; bottom: -2px; z-index: 4; display: grid; min-width: 18px; height: 18px; place-items: center; border: 2px solid var(--cx-surface-raised,#20242b); border-radius: 999px; padding: 0 2px; background: var(--cx-hover,#343942); color: var(--cx-text,#edf0f4); font-size: 7px; font-weight: 700; }
  .cxr-manager-collection-actions { display: flex; align-items: center; gap: 3px; padding-right: 8px; }
  .cxr-manager-collection-action[data-tone="danger"] { color: var(--cx-danger,#ff6b72); }
  .cxr-manager-collection-overflow { position: relative; display: inline-flex; }
  .cxr-manager-collection-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 12; display: grid; width: max-content; min-width: 168px; gap: 2px; border: 1px solid var(--cx-border,#353a42); border-radius: 10px; padding: 5px; background: var(--cx-surface,#17191d); box-shadow: 0 12px 30px rgb(0 0 0 / 32%); }
  .cxr-manager-collection-menu button { display: grid; grid-template-columns: 18px minmax(0,1fr); align-items: center; gap: 8px; border: 0; border-radius: 7px; padding: 7px 9px; background: transparent; color: var(--cx-text,#edf0f4); text-align: left; font: inherit; cursor: pointer; }
  .cxr-manager-collection-menu button:hover:not(:disabled), .cxr-manager-collection-menu button:focus-visible { outline: 0; background: var(--cx-hover,rgba(255,255,255,.08)); }
  .cxr-manager-collection-menu button[data-tone="danger"] { color: var(--cx-danger,#ff6b72); }
  .cxr-manager-collection-menu button:disabled { opacity: .5; cursor: default; }
  .cxr-manager-collection-state { display: grid; min-height: 128px; place-content: center; justify-items: center; gap: 4px; color: var(--cx-muted,#9ca5b5); text-align: center; }
  .cxr-manager-collection-state strong { color: var(--cx-text,#edf0f4); font-size: 14px; }
  .cxr-manager-collection-state button { margin-top: 5px; border: 1px solid var(--cx-border,#353a42); border-radius: 8px; padding: 6px 10px; background: transparent; color: var(--cx-text,#edf0f4); font: inherit; cursor: pointer; }
  .cxr-manager-collection-state button:hover { background: var(--cx-hover,rgba(255,255,255,.08)); }
  .cxr-manager-collection-state button:focus-visible { outline: 2px solid var(--cx-focus,#8aa8ff); outline-offset: 2px; }
  .cxr-manager-collection-feedback { position: sticky; bottom: 10px; z-index: 8; display: flex; width: fit-content; max-width: min(520px,100%); align-items: center; justify-self: center; gap: 8px; border: 1px solid var(--cx-border,#353a42); border-radius: 9px; padding: 7px 8px 7px 11px; background: var(--cx-surface,#17191d); box-shadow: 0 8px 24px rgb(0 0 0 / 28%); }
  .cxr-manager-collection-feedback[data-tone="error"] { border-color: color-mix(in srgb,var(--cx-danger,#ff6b72) 55%,var(--cx-border,#353a42)); }
  .cxr-manager-collection-dialog-backdrop { position: fixed; inset: 0; z-index: 2147483590; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 58%); }
  .cxr-manager-collection-dialog { display: grid; width: min(440px,calc(100vw - 40px)); gap: 13px; border: 1px solid var(--cx-border,#353a42); border-radius: 13px; padding: 18px; background: var(--cx-surface,#17191d); box-shadow: 0 20px 70px rgb(0 0 0 / 42%); }
  .cxr-manager-collection-dialog h3, .cxr-manager-collection-dialog p { margin: 0; }
  .cxr-manager-collection-dialog p { color: var(--cx-muted,#9ca5b5); }
  .cxr-manager-collection-dialog label { display: grid; gap: 6px; }
  .cxr-manager-collection-dialog input { width: 100%; border: 1px solid var(--cx-border,#353a42); border-radius: 8px; padding: 8px 10px; outline: 0; background: var(--cx-surface-raised,#20242b); color: var(--cx-text,#edf0f4); font: inherit; }
  .cxr-manager-collection-dialog input:focus { border-color: var(--cx-focus,#8aa8ff); box-shadow: 0 0 0 1px var(--cx-focus,#8aa8ff); }
  .cxr-manager-collection-dialog input[aria-invalid="true"] { border-color: var(--cx-danger,#ff6b72); }
  .cxr-manager-collection-dialog-actions { display: flex; justify-content: flex-end; gap: 7px; }
  .cxr-manager-collection-dialog-actions button { border: 1px solid var(--cx-border,#353a42); border-radius: 8px; padding: 7px 12px; background: transparent; color: var(--cx-text,#edf0f4); font: inherit; cursor: pointer; }
  .cxr-manager-collection-dialog-actions button[data-tone="primary"] { border-color: var(--cx-primary,#4c8dff); background: var(--cx-primary,#4c8dff); color: #fff; }
  .cxr-manager-collection-dialog-actions button[data-tone="danger"] { border-color: var(--cx-danger,#ff6b72); background: var(--cx-danger,#ff6b72); color: #fff; }
  .cxr-manager-collection-dialog-actions button:disabled { opacity: .5; cursor: default; }
  .cxr-manager-collection-dialog-actions button:focus-visible { outline: 2px solid var(--cx-focus,#8aa8ff); outline-offset: 2px; }
  @media (max-width: 760px) {
    .cxr-backdrop { padding: 0; }
    .cxr-dialog { width: 100vw; height: 100vh; grid-template-columns: 76px minmax(0,1fr); border-radius: 0; }
    .cxr-sidebar { padding: 8px; }
    .cxr-nav button { grid-template-columns: 1fr; justify-items: center; padding: 5px; }
    .cxr-nav button span:last-child { display: none; }
    .cxr-content { padding: 12px; }
    .cxr-grid { grid-template-columns: 1fr; }
    .cxr-marketplace-tool-actions .t-button { width: 28px; height: 28px; }
  }
  ${PLUGIN_CONSOLE_REACT_STYLES}
  ${HOST_FORM_REACT_STYLES}
  ${HOST_COLLECTION_STYLES}
`}`
