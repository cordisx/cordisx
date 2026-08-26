import { PLUGIN_CONSOLE_REACT_STYLES } from './components/PluginConsolePanel.js'
import { HOST_FORM_REACT_STYLES } from '../host-ui/HostForm.js'
import { HOST_COLLECTION_STYLES } from '../host-collection.js'
import tdesignReactCss from 'tdesign-react/es/style/index.css'

const scopedTDesignReactCss = tdesignReactCss.replace(
  ":root.dark,\n:root[theme-mode='dark']",
  ".cxr-root[data-cordisx-app-theme='dark']",
)

export const REACT_MANAGER_STYLES = `${scopedTDesignReactCss}\n${String.raw`
  .cxr-root { position: relative; z-index: 2147483000; color: var(--cx-text, #edf0f4); font: 13px/1.45 system-ui, sans-serif; }
  .cxr-root *, .cxr-root *::before, .cxr-root *::after { box-sizing: border-box; }
  .cxr-brand-mark { display: inline-grid; width: 18px; height: 18px; flex: none; place-items: center; }
  .cxr-brand-mark img { width: 100%; height: 100%; object-fit: contain; }
  .cxr-brand-mark-light { display: none; }
  .cxr-root[data-cordisx-app-theme="light"] .cxr-brand-mark-dark { display: none; }
  .cxr-root[data-cordisx-app-theme="light"] .cxr-brand-mark-light { display: block; }
  .cxr-trigger { display: inline-grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  .cxr-trigger:hover { background: var(--cx-hover, rgba(255,255,255,.08)); }
  .cxr-trigger img { width: 20px; height: 20px; }
  .cxr-backdrop { position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 58%); }
  .cxr-dialog { display: grid; width: min(1236px, calc(100vw - 40px)); height: min(860px, calc(100vh - 40px)); overflow: hidden; grid-template-columns: 264px minmax(0,1fr); border: 1px solid var(--cx-border, #353a42); border-radius: 18px; background: var(--cx-surface, #17191d); box-shadow: 0 30px 100px rgb(0 0 0 / 50%); }
  .cxr-sidebar { display: flex; min-height: 0; flex-direction: column; padding: 12px; border-right: 1px solid var(--cx-border, #353a42); background: var(--cx-surface-raised, #20242b); }
  .cxr-nav { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 3px; }
  .cxr-nav-spacer { flex: 1; }
  .cxr-nav button { display: grid; min-height: 40px; grid-template-columns: 28px minmax(0,1fr); align-items: center; gap: 7px; border: 0; border-radius: 9px; padding: 5px 9px; background: transparent; color: var(--cx-muted, #aab2c0); cursor: pointer; text-align: left; font: inherit; }
  .cxr-nav button:hover, .cxr-nav button[aria-current="page"] { background: var(--cx-hover, rgba(255,255,255,.08)); color: var(--cx-text, #edf0f4); }
  .cxr-nav button:focus-visible { outline: 2px solid var(--cx-focus, #8aa8ff); outline-offset: 1px; }
  .cxr-nav .cxh-icon-seat, .cxr-nav .cxm-material-icon { display: grid; width: 18px; height: 18px; place-items: center; }
  .cxr-nav button > :first-child { display: grid; width: 18px; height: 18px; align-self: center; justify-self: center; place-items: center; line-height: 1; }
  .cxr-main { display: grid; min-width: 0; min-height: 0; grid-template-rows: auto minmax(0,1fr); }
  .cxr-header { display: grid; grid-template-columns: 32px minmax(0,1fr) 32px; align-items: center; gap: 8px; padding: 10px 18px; border-bottom: 1px solid var(--cx-border, #353a42); }
  .cxr-header-seat { display: grid; width: 32px; height: 32px; place-items: center; }
  .cxr-header > .t-button, .cxr-header-seat > .t-button { width: 32px; height: 32px; padding: 0; }
  .cxr-header-seat > .t-icon, .cxr-header > .t-button .t-icon, .cxr-header-seat > .t-button .t-icon { width: 16px; height: 16px; color: var(--cx-muted, #aab2c0); font-size: 16px !important; }
  .cxr-header-seat > .cxr-brand-mark { width: 18px; height: 18px; }
  .cxr-heading { min-width: 0; }
  .cxr-heading h2 { margin: 0; overflow: hidden; color: var(--cx-text, #edf0f4); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-breadcrumbs { display: flex; min-width: 0; align-items: center; gap: 7px; overflow: hidden; color: var(--cx-muted, #9ca5b5); font-size: 14px; white-space: nowrap; }
  .cxr-breadcrumb-segment { display: flex; min-width: 0; align-items: center; gap: 7px; }
  .cxr-breadcrumbs button { min-width: 0; overflow: hidden; border: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-breadcrumbs button:hover { color: var(--cx-text, #edf0f4); }
  .cxr-breadcrumbs [aria-current="page"] { min-width: 0; overflow: hidden; color: var(--cx-text, #edf0f4); font-weight: 650; text-overflow: ellipsis; }
  .cxr-content { min-width: 0; min-height: 0; overflow: auto; padding: 16px 22px 22px; }
  .cxr-content:has(.cxm-console-panel) { display: flex; overflow: hidden; }
  .cxr-content:has(.cxm-console-panel) > * { min-height: 0; flex: 1; }
  .cxr-page { width: 100%; min-width: 0; }
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
  .cxr-list { display: grid; gap: 7px; margin-top: 12px; }
  .cxr-card { display: flex; min-width: 0; align-items: center; gap: 11px; width: 100%; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; padding: 11px 12px; background: var(--cx-surface-raised,#20242b); color: inherit; text-align: left; }
  button.cxr-card { cursor: pointer; }
  button.cxr-card:hover { border-color: color-mix(in srgb, var(--cx-text,#fff) 30%, var(--cx-border,#353a42)); background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-card-icon { position: relative; display: grid; width: 34px; height: 34px; flex: none; place-items: center; border-radius: 9px; background: var(--cx-hover,rgba(255,255,255,.08)); color: var(--cx-muted,#aab2c0); font-weight: 700; }
  .cxr-status-dot { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border: 2px solid var(--cx-surface-raised,#20242b); border-radius: 50%; background: var(--cx-muted,#8b95a5); }
  .cxr-status-dot[data-status="active"] { background: var(--cx-success,#4dc78f); }
  .cxr-status-dot[data-status="failed"], .cxr-status-dot[data-status="rollback-failed"] { background: var(--cx-danger,#f36d7d); }
  .cxr-status-dot[data-status="blocked"], .cxr-status-dot[data-status="permission-blocked"] { background: var(--cx-warning,#e7b75b); }
  .cxr-card-body { min-width: 0; flex: 1; }
  .cxr-card-title { display: block; overflow: hidden; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-card-description { display: block; margin-top: 3px; overflow: hidden; color: var(--cx-muted,#9ca5b5); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-card-code { display: block; margin-top: 4px; color: var(--cx-muted,#7f899a); font: 10px/1.3 ui-monospace,monospace; }
  .cxr-status { flex: none; color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxr-status[data-tone="danger"] { color: var(--cx-danger,#f59aa4); }
  .cxr-plugin-row { position: relative; display: flex; min-width: 0; align-items: center; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-plugin-row:hover, .cxr-plugin-row:focus-within { border-color: color-mix(in srgb, var(--cx-text,#fff) 30%, var(--cx-border,#353a42)); background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-plugin-primary { display: flex; min-width: 0; flex: 1; align-items: center; gap: 11px; border: 0; padding: 11px 12px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
  .cxr-plugin-actions { position: absolute; top: 8px; right: 8px; z-index: 1; display: flex; align-items: center; gap: 2px; border-radius: 8px; padding: 2px; background: color-mix(in srgb,var(--cx-surface-raised,#20242b) 92%,transparent); box-shadow: 0 2px 12px rgb(0 0 0 / 20%); opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
  .cxr-plugin-row:hover .cxr-plugin-actions, .cxr-plugin-row:focus-within .cxr-plugin-actions { opacity: 1; pointer-events: auto; }
  .cxr-tabs { display: flex; gap: 2px; overflow-x: auto; margin: -5px 0 12px; border-bottom: 1px solid var(--cx-border,#353a42); }
  .cxr-tabs button { display: inline-flex; height: 38px; flex: none; align-items: center; gap: 6px; border: 0; border-bottom: 2px solid transparent; padding: 0 9px; background: transparent; color: var(--cx-muted,#9ca5b5); cursor: pointer; }
  .cxr-tabs button .t-icon { font-size: 15px; }
  .cxr-tabs button[aria-selected="true"] { border-bottom-color: var(--cx-primary,#7da2ff); color: var(--cx-text,#edf0f4); }
  .cxr-empty, .cxr-notice { padding: 18px; border: 1px dashed var(--cx-border,#353a42); border-radius: 10px; color: var(--cx-muted,#9ca5b5); text-align: center; }
  .cxr-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
  .cxr-section { padding: 13px; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-section h3, .cxr-section h4 { margin: 0; }
  .cxr-section p { margin: 5px 0 0; color: var(--cx-muted,#9ca5b5); }
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
  .cxr-marketplace-card .cxr-card-icon img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
  .cxr-marketplace-actions { position: absolute; top: 8px; right: 8px; z-index: 1; display: flex; align-items: center; gap: 2px; border-radius: 8px; padding: 2px; background: color-mix(in srgb,var(--cx-surface-raised,#20242b) 92%,transparent); box-shadow: 0 2px 12px rgb(0 0 0 / 20%); opacity: 0; pointer-events: none; transition: opacity 120ms ease; }
  .cxr-marketplace-card:hover .cxr-marketplace-actions, .cxr-marketplace-card:focus-within .cxr-marketplace-actions { opacity: 1; pointer-events: auto; }
  .cxr-marketplace-meta { align-self: end; color: var(--cx-muted); font-size: 10px; }
  .cxr-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; margin-top: 12px; }
  .cxr-button { min-height: 32px; border: 1px solid var(--cx-border,#353a42); border-radius: 8px; padding: 5px 10px; background: var(--cx-hover,rgba(255,255,255,.06)); color: inherit; cursor: pointer; }
  .cxr-button:disabled { opacity: .4; cursor: default; }
  .cxr-button[data-tone="danger"] { color: var(--cx-danger,#f59aa4); }
  .cxr-markdown { width: min(100%,820px); min-width: 0; margin: 0 auto; color: var(--cx-text,#edf0f4); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
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
  .cxr-markdown pre code { padding: 0; background: transparent; }
  .cxr-markdown blockquote { border-left: 3px solid var(--cx-border,#353a42); padding-left: 12px; color: var(--cx-muted,#9ca5b5); }
  .cxr-markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
  .cxr-markdown th, .cxr-markdown td { border: 1px solid var(--cx-border,#353a42); padding: 6px 9px; text-align: left; }
  .cxr-readable-code { font: 11px/1.5 ui-monospace,monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .cxr-plugin-identity { display: flex; min-width: 0; align-items: center; gap: 12px; margin-bottom: 10px; border: 1px solid var(--cx-border,#353a42); border-radius: 11px; padding: 10px 12px; background: var(--cx-surface-raised,#20242b); }
  .cxr-plugin-identity .cxr-card-icon { width: 42px; height: 42px; }
  .cxr-plugin-identity-copy { display: grid; min-width: 0; flex: 1; gap: 3px; }
  .cxr-plugin-identity-copy strong { overflow: hidden; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
  .cxr-plugin-identity-meta { display: flex; min-width: 0; flex-wrap: wrap; gap: 5px 10px; color: var(--cx-muted,#9ca5b5); font-size: 10px; }
  .cxr-plugin-identity-meta a { color: inherit; }
  .cxr-plugin-identity-actions { display: flex; flex: none; align-items: center; gap: 6px; }
  .cxr-plugin-identity-actions .t-button { width: 34px; height: 34px; flex: none; padding: 0; }
  .cxr-metrics { display: grid; grid-template-columns: repeat(auto-fit,minmax(120px,1fr)); gap: 8px; }
  .cxr-metric { display: grid; gap: 4px; border: 1px solid var(--cx-border,#353a42); border-radius: 10px; padding: 11px; background: var(--cx-surface-raised,#20242b); }
  .cxr-metric span { color: var(--cx-muted,#9ca5b5); font-size: 10px; }
  .cxr-metric strong { font-size: 17px; }
  .cxr-token-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .cxr-token-list code { border-radius: 6px; padding: 4px 7px; background: var(--cx-hover,rgba(255,255,255,.07)); }
  .cxr-about-identity { display: flex; align-items: center; flex-direction: column; justify-content: center; gap: 8px; margin: 4px 0 18px; text-align: center; }
  .cxr-about-identity > .cxr-brand-mark { width: 56px; height: 56px; }
  .cxr-about-identity > div { display: grid; justify-items: center; gap: 3px; }
  .cxr-about-identity strong { font-size: 16px; }
  .cxr-about-identity span { color: var(--cx-muted,#9ca5b5); font-size: 11px; }
  .cxr-about-links { width: 100%; max-width: none; }
  .cxr-about-links > a { text-decoration: none; }
  .cxr-about-links > a > .t-icon { flex: none; color: var(--cx-muted,#9ca5b5); font-size: 15px; }
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
