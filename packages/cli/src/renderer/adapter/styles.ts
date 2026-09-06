interface StructuredStyleOwnership {
  readonly element: HTMLStyleElement
  references: number
}

const structuredStyleOwnership = new WeakMap<Document, StructuredStyleOwnership>()

function assertStructuredStyleOwnership(document: Document): void {
  const shared = structuredStyleOwnership.get(document)
  if (shared !== undefined) {
    if (
      !shared.element.isConnected
      || document.getElementById('cordisx-structured-styles') !== shared.element
      || document.querySelectorAll('#cordisx-structured-styles').length !== 1
    ) {
      throw new Error('CordisX structured style ownership is stale')
    }
    return
  }
  if (document.getElementById('cordisx-structured-styles') !== null) {
    throw new Error('CordisX structured styles are already owned by another renderer')
  }
}

function installStyles(document: Document): () => void {
  assertStructuredStyleOwnership(document)
  const shared = structuredStyleOwnership.get(document)
  if (shared !== undefined) {
    shared.references += 1
    let released = false
    return () => {
      if (released) return
      released = true
      shared.references -= 1
      if (shared.references > 0) return
      shared.element.remove()
      structuredStyleOwnership.delete(document)
    }
  }
  const style = document.createElement('style')
  style.id = 'cordisx-structured-styles'
  style.textContent = `
    .cordisx-nav-primary > .cordisx-navigation-image-seat.cxsi-icon { position:relative; display:block; box-sizing:border-box; flex:0 0 16px; width:16px; min-width:16px; max-width:16px; height:16px; min-height:16px; max-height:16px; margin:0; padding:0; overflow:hidden; border:0; border-radius:50%; background:transparent; pointer-events:none; }
    .cordisx-navigation-image-seat > img { display:block; width:100%; height:100%; object-fit:cover; pointer-events:none; }
    [data-cordisx-no-drag="true"], [data-cordisx-no-drag="true"] * { -webkit-app-region: no-drag !important; }
    .cordisx-native-seat { box-sizing: border-box; color: inherit; font: inherit; pointer-events: auto; -webkit-app-region: no-drag; }
    .cordisx-native-seat[hidden] { display: none !important; }
    .cordisx-reasoning-intensity { --cordisx-reasoning-edge:#dad7cf; --cordisx-reasoning-light:#f8f7f2; --cordisx-reasoning-mid:#cbc6ba; --cordisx-reasoning-dark:#5a5650; box-sizing:border-box; display:block; min-height:28px; padding:3px; overflow:hidden; border:1px solid color-mix(in oklab,var(--cordisx-reasoning-edge) 46%,#16120d); border-radius:999px; background:linear-gradient(180deg,color-mix(in oklab,var(--cordisx-reasoning-dark) 24%,#17130e),color-mix(in oklab,var(--cordisx-reasoning-dark) 46%,#0b0907)); box-shadow:inset 0 1px rgba(255,255,255,.08),0 2px 4px rgba(0,0,0,.14); transition:border-color 360ms ease,background 360ms ease,box-shadow 360ms ease; }
    .cordisx-reasoning-intensity[data-material="plastic"] { --cordisx-reasoning-edge:#eeeae1; --cordisx-reasoning-light:#fffefa; --cordisx-reasoning-mid:#d8d4cb; --cordisx-reasoning-dark:#77736c; }
    .cordisx-reasoning-intensity[data-material="bronze"] { --cordisx-reasoning-edge:#d09b5b; --cordisx-reasoning-light:#ffd197; --cordisx-reasoning-mid:#a9632d; --cordisx-reasoning-dark:#4d2a19; }
    .cordisx-reasoning-intensity[data-material="steel"] { --cordisx-reasoning-edge:#9fb1b7; --cordisx-reasoning-light:#dce7e9; --cordisx-reasoning-mid:#70868e; --cordisx-reasoning-dark:#27383e; }
    .cordisx-reasoning-intensity[data-material="silver"] { --cordisx-reasoning-edge:#e8e9ea; --cordisx-reasoning-light:#fff; --cordisx-reasoning-mid:#aeb4ba; --cordisx-reasoning-dark:#555d65; }
    .cordisx-reasoning-intensity[data-material="gold"] { --cordisx-reasoning-edge:#d7bd70; --cordisx-reasoning-light:#ead28a; --cordisx-reasoning-mid:#b8872f; --cordisx-reasoning-dark:#5e4824; }
    .cordisx-reasoning-fill { position:absolute; inset:3px auto 3px 3px; max-width:calc(100% - 6px); border-radius:999px; background:linear-gradient(180deg,var(--cordisx-reasoning-light) 0%,var(--cordisx-reasoning-mid) 48%,color-mix(in oklab,var(--cordisx-reasoning-mid) 72%,var(--cordisx-reasoning-dark)) 100%); box-shadow:inset 0 1px rgba(255,255,255,.48),inset 0 -1px rgba(0,0,0,.16),0 0 4px color-mix(in oklab,var(--cordisx-reasoning-mid) 22%,transparent); transition:width 320ms cubic-bezier(.22,.8,.2,1),background 360ms ease,box-shadow 360ms ease; }
    .cordisx-reasoning-fill::after { content:""; position:absolute; inset:12% 7% auto; height:18%; border-radius:999px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.38),transparent); opacity:.65; }
    .cordisx-reasoning-ticks { position:absolute; inset:3px; display:flex; justify-content:space-between; align-items:center; padding:0 5px; }
    .cordisx-reasoning-ticks i { display:block; width:3px; height:3px; border-radius:50%; background:color-mix(in oklab,var(--cordisx-reasoning-light) 62%,transparent); box-shadow:0 1px rgba(0,0,0,.24); opacity:.62; }
    .cordisx-reasoning-thumb { position:absolute; top:50%; width:42px; height:calc(100% - 6px); min-height:24px; max-height:28px; display:flex; gap:2px; align-items:center; justify-content:center; padding:2px; border:1px solid color-mix(in oklab,var(--cordisx-reasoning-edge) 62%,#5b451b); border-radius:999px; background:linear-gradient(145deg,var(--cordisx-reasoning-light),var(--cordisx-reasoning-mid)); box-shadow:inset 0 1px rgba(255,255,255,.52),inset 0 -1px rgba(0,0,0,.09),0 1px 2px rgba(0,0,0,.16); transform:translate(-50%,-50%); transition:left 320ms cubic-bezier(.22,.8,.2,1),background 360ms ease,border-color 360ms ease,box-shadow 360ms ease; }
    .cordisx-reasoning-thumb i { display:block; width:16px; height:16px; border-radius:50%; background:radial-gradient(circle at 34% 28%,#fff 0%,var(--cordisx-reasoning-light) 44%,var(--cordisx-reasoning-mid) 100%); box-shadow:inset -1px -1px 2px rgba(0,0,0,.08),0 1px 1px rgba(0,0,0,.10); }
    .cordisx-reasoning-particles { position:absolute; inset:3px; overflow:hidden; opacity:0; transition:opacity 420ms ease; }
    .cordisx-reasoning-particles i { position:absolute; left:calc(var(--cordisx-reasoning-progress) - 24px); top:var(--particle-y); width:2.5px; height:1.25px; border-radius:100% 0 100% 0; background:var(--cordisx-reasoning-light); box-shadow:0 0 3px var(--cordisx-reasoning-mid); transform:translate(-50%,-50%) rotate(calc(var(--particle-index) * 29deg)); }
    .cordisx-reasoning-intensity[data-peak="true"][data-motion="ascension"] .cordisx-reasoning-particles { opacity:1; }
    .cordisx-reasoning-intensity[data-peak="true"][data-motion="ascension"] .cordisx-reasoning-particles i { animation:cordisx-reasoning-spark 1.45s var(--particle-delay) ease-in-out infinite; }
    .cordisx-reasoning-intensity[data-dragging="true"] .cordisx-reasoning-fill,.cordisx-reasoning-intensity[data-dragging="true"] .cordisx-reasoning-thumb { transition-duration:0ms; }
    @keyframes cordisx-reasoning-spark { 0%,100% { opacity:.15; transform:translate(-8px,-50%) scale(.55) rotate(calc(var(--particle-index) * 29deg)); } 42% { opacity:1; transform:translate(calc(8px + var(--particle-index) * 1.4px),calc(-50% - 7px)) scale(1) rotate(calc(24deg + var(--particle-index) * 29deg)); } 75% { opacity:.35; transform:translate(calc(18px + var(--particle-index) * 2px),calc(-50% + 5px)) scale(.7) rotate(calc(56deg + var(--particle-index) * 29deg)); } }
    .cordisx-reasoning-native-menu-shell { position:relative; height:32px; margin:4px 8px 6px; }
    .cordisx-reasoning-native-menu-range { position:absolute; inset:0; z-index:1; width:100%; height:100%; margin:0; cursor:grab; }
    .cordisx-reasoning-native-menu-range:active { cursor:grabbing; }
    .cordisx-session-backdrop { --cordisx-backdrop-accent:#e8e2d8; --cordisx-backdrop-strength:.16; position:absolute; inset:0; z-index:0; overflow:hidden; pointer-events:none; }
    .cordisx-session-backdrop[data-material="bronze"] { --cordisx-backdrop-accent:#bb6d32; --cordisx-backdrop-strength:.20; }
    .cordisx-session-backdrop[data-material="steel"] { --cordisx-backdrop-accent:#77929c; --cordisx-backdrop-strength:.23; }
    .cordisx-session-backdrop[data-material="silver"] { --cordisx-backdrop-accent:#d9e1e6; --cordisx-backdrop-strength:.27; }
    .cordisx-session-backdrop[data-material="gold"] { --cordisx-backdrop-accent:#e6b83f; --cordisx-backdrop-strength:.34; }
    .cordisx-session-backdrop-glow { position:absolute; inset:0; opacity:var(--cordisx-backdrop-strength); background:radial-gradient(circle at 76% 55%,color-mix(in oklab,var(--cordisx-backdrop-accent) 34%,transparent),transparent 38%),linear-gradient(112deg,transparent 0 50%,color-mix(in oklab,var(--cordisx-backdrop-accent) 12%,transparent) 74%,transparent 100%); transition:opacity 480ms ease,background 480ms ease; }
    .cordisx-session-backdrop-architecture { position:absolute; width:min(58vw,720px); aspect-ratio:1; right:-5vw; bottom:clamp(92px,11vh,128px); border:1px solid color-mix(in oklab,var(--cordisx-backdrop-accent) 40%,transparent); border-radius:50%; box-shadow:0 0 0 5vw color-mix(in oklab,var(--cordisx-backdrop-accent) 3.5%,transparent),0 0 0 11vw color-mix(in oklab,var(--cordisx-backdrop-accent) 2.5%,transparent); opacity:calc(.10 + var(--cordisx-backdrop-progress) * .34); transform:translateY(44%) rotate(calc(-12deg + var(--cordisx-backdrop-progress) * 18deg)); transition:opacity 480ms ease,transform 620ms cubic-bezier(.2,.8,.2,1),border-color 480ms ease; }
    .cordisx-session-backdrop-architecture::before,.cordisx-session-backdrop-architecture::after { content:""; position:absolute; inset:10%; border:1px solid color-mix(in oklab,var(--cordisx-backdrop-accent) 36%,transparent); border-radius:50%; }
    .cordisx-session-backdrop-architecture::after { inset:24%; border-radius:2%; transform:rotate(45deg); }
    .cordisx-session-backdrop-portrait { position:absolute; right:0; bottom:0; width:auto; height:66.6667vh; max-width:none; max-height:none; object-fit:contain; object-position:right bottom; filter:drop-shadow(-16px 6px 24px rgba(0,0,0,.34)) saturate(calc(.84 + var(--cordisx-backdrop-progress) * .24)); opacity:calc(.26 + var(--cordisx-backdrop-progress) * .52); transform-origin:right bottom; transition:opacity 520ms ease,filter 520ms ease; }
    .cordisx-session-backdrop-portrait[data-active="false"] { opacity:0; }
    .cordisx-session-backdrop[data-peak="true"] .cordisx-session-backdrop-architecture { animation:cordisx-backdrop-crown 8s linear infinite; }
    @keyframes cordisx-backdrop-crown { to { transform:translateY(44%) rotate(366deg); } }
    @media (prefers-reduced-motion:reduce) { .cordisx-reasoning-intensity *,.cordisx-session-backdrop * { animation:none!important; transition-duration:0ms!important; } }
    .cordisx-sidebar-navigation { display: block; width: 100%; min-width: 0; container-type: inline-size; }
    .cordisx-sidebar-footer-before, .cordisx-sidebar-footer-after { display: flex; flex: 0 0 auto; height: 32px; align-items: center; gap: 4px; min-width: 0; }
    .cordisx-toolbar-before, .cordisx-toolbar-after, .cordisx-session-header-actions { --cordisx-toolbar-action-target-size: 28px; --cordisx-toolbar-action-corner-radius: 8px; --cordisx-toolbar-action-idle-background: transparent; --cordisx-toolbar-action-hover-background: var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); --cordisx-toolbar-action-focus-ring: var(--color-ring,rgba(131,195,255,.76)); --cordisx-toolbar-action-disabled-opacity: .4; --cordisx-toolbar-action-pressed-background: color-mix(in oklab,var(--color-text,currentColor) 5%,transparent); --cordisx-toolbar-action-pressed-hover-background: color-mix(in oklab,var(--color-text,currentColor) 10%,transparent); --cordisx-toolbar-action-pressed-foreground: var(--color-text,currentColor); --cordisx-toolbar-action-gap: 6px; display: flex; flex: 0 0 auto; height: var(--cordisx-toolbar-action-target-size); align-items: center; gap: var(--cordisx-toolbar-action-gap); min-width: 0; }
    .cordisx-session-header-actions { --cordisx-toolbar-outer-group-gap: 6px; margin-inline-end: var(--cordisx-toolbar-outer-group-gap); }
    .cordisx-composer-submit-before { display: flex; flex: 0 0 auto; height: 28px; align-items: center; gap: 8px; min-width: 0; }
    .cordisx-environment { display: contents; }
    .cordisx-navigation, .cordisx-navigation-group { display: grid; gap: 1px; }
    .cordisx-navigation-group { min-width: 0; margin-top: 12px; }
    .cordisx-navigation-group-heading { min-width: 0; padding: 0 8px 4px; overflow: hidden; color: var(--color-text-secondary,var(--color-text-tertiary,currentColor)); font: 500 11px/16px system-ui,sans-serif; text-overflow: ellipsis; white-space: nowrap; }
    @container (max-width: 80px) { .cordisx-navigation-group { margin-top: 6px; } .cordisx-navigation-group-heading { display: none; } }
    .pg-sidebar .cxsi-row.cordisx-nav-row { --cordisx-nav-content-gutter:var(--space-2,8px); --cordisx-nav-content-gap:var(--space-2,8px); --cordisx-nav-action-gap:var(--space-1,4px); --cordisx-nav-action-target:24px; --cordisx-nav-row-interactive-surface:var(--color-background-primary-ghost-hover,color-mix(in srgb,currentColor 8%,transparent)); --cordisx-nav-row-selected-hover-surface:color-mix(in srgb,var(--cordisx-nav-row-interactive-surface) 92%,currentColor 8%); display:flex; inline-size:auto; max-inline-size:100%; min-width:0; height:auto; box-sizing:border-box; align-items:center; gap:var(--cordisx-nav-content-gap); min-height:var(--height-token-row,30px); padding-block:0; padding-inline:var(--cordisx-nav-content-gutter); overflow:visible; border-radius:var(--radius-lg,10px); background:transparent; -webkit-app-region:no-drag; }
    .cordisx-nav-row[data-variant="two-line"] { min-height: 46px; }
    .pg-sidebar .cxsi-row.cordisx-nav-row:hover, .pg-sidebar .cxsi-row.cordisx-nav-row:focus-within { background:var(--cordisx-nav-row-interactive-surface); }
    .pg-sidebar .cxsi-row.cordisx-nav-row[data-selected="true"], .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="active"], .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="presented"] { background:var(--cordisx-nav-row-interactive-surface); }
    .pg-sidebar .cxsi-row.cordisx-nav-row[data-selected="true"]:hover, .pg-sidebar .cxsi-row.cordisx-nav-row[data-selected="true"]:focus-within, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="active"]:hover, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="active"]:focus-within, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="presented"]:hover, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="presented"]:focus-within { background:var(--cordisx-nav-row-selected-hover-surface); }
    .pg-sidebar .cxsi-row.cordisx-nav-row > .cxsi-primary.cordisx-nav-primary { appearance:none; display:grid; flex:1 1 auto; grid-template-columns:16px minmax(0,1fr); align-items:center; gap:8px; height:100%; min-width:0; padding:0; border:0; background:transparent; color:inherit; font:445 13px/18px system-ui,sans-serif; text-align:left; cursor:default; }
    .cxsi-row.cordisx-nav-row > .cxsi-primary.cordisx-nav-primary, .cxsi-row.cordisx-nav-row > .cxsi-primary.cordisx-nav-primary:hover, .cxsi-row.cordisx-nav-row > .cxsi-primary.cordisx-nav-primary[aria-pressed="true"], .cxsi-row.cordisx-nav-row > .cxsi-primary.cordisx-nav-primary[aria-current="page"] { background:transparent; }
    .cordisx-nav-primary:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: -2px; border-radius: var(--radius-lg,10px); }
    .cordisx-nav-copy { display: grid; min-width: 0; overflow: hidden; }
    .cordisx-nav-copy > .cxsi-title, .cordisx-nav-copy > .cxsi-secondary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-nav-copy > .cxsi-secondary { color: var(--color-text-tertiary,rgba(127,127,127,.72)); font: 400 11px/15px system-ui,sans-serif; }
    .cordisx-nav-actions { display:flex; min-width:0; flex:0 0 auto; align-items:center; gap:var(--cordisx-nav-action-gap); opacity:0; pointer-events:none; transition:opacity 120ms ease; }
    .cordisx-nav-row:hover > .cordisx-nav-actions, .cordisx-nav-row:focus-within > .cordisx-nav-actions, .cordisx-nav-row[data-selected="true"] > .cordisx-nav-actions, .cordisx-nav-row[data-cordisx-route-state="presented"] > .cordisx-nav-actions { opacity: 1; pointer-events: auto; }
    .cordisx-navigation-direct-action, .cordisx-navigation-more-action { display:inline-flex; width:var(--cordisx-nav-action-target); min-width:var(--cordisx-nav-action-target); height:var(--cordisx-nav-action-target); min-height:var(--cordisx-nav-action-target); flex:0 0 var(--cordisx-nav-action-target); align-items:center; justify-content:center; padding:0; border:0; border-radius:var(--radius-md,7px); background:transparent; color:var(--color-text-tertiary,currentColor); }
    .cordisx-navigation-direct-action:hover:not(:disabled), .cordisx-navigation-more-action:hover:not(:disabled), .cordisx-navigation-direct-action[aria-pressed="true"] { background:var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); color:var(--color-text,currentColor); }
    .cordisx-navigation-direct-action:focus-visible, .cordisx-navigation-more-action:focus-visible { outline:2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset:-1px; }
    .cordisx-navigation-direct-action:disabled, .cordisx-navigation-more-action:disabled { opacity:.4; }
    .cordisx-navigation-action-icon-slot { display:inline-flex; width:16px; height:16px; align-items:center; justify-content:center; color:inherit; pointer-events:none; }
    .cordisx-navigation-direct-action .cordisx-host-icon, .cordisx-navigation-more-action .cordisx-host-icon, .cordisx-navigation-direct-action .cordisx-host-icon svg, .cordisx-navigation-more-action .cordisx-host-icon svg { width:14px; height:14px; }
    .cordisx-navigation-menu { position:fixed; z-index:2147483200; display:grid; min-width:180px; padding:5px; border:1px solid var(--color-border,rgba(127,127,127,.24)); border-radius:10px; background:var(--color-surface-elevated,var(--color-background-elevated,#272727)); color:var(--color-text,currentColor); box-shadow:0 10px 30px rgba(0,0,0,.28); -webkit-app-region:no-drag; }
    .cordisx-navigation-menu-item { display:grid; width:100%; min-height:30px; box-sizing:border-box; grid-template-columns:16px minmax(0,1fr); align-items:center; column-gap:var(--space-2,8px); padding:5px 8px; border:0; border-radius:7px; background:transparent; color:inherit; font:400 13px/18px system-ui,sans-serif; text-align:left; }
    .cordisx-navigation-menu-icon-slot { display:inline-flex; width:16px; height:16px; align-items:center; justify-content:center; color:inherit; pointer-events:none; }
    .cordisx-navigation-menu-icon-slot .cordisx-host-icon, .cordisx-navigation-menu-icon-slot .cordisx-host-icon svg { width:16px; height:16px; }
    .cordisx-navigation-menu-item > span:last-child { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .cordisx-navigation-menu-item:hover:not(:disabled), .cordisx-navigation-menu-item:focus-visible { outline:none; background:var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); }
    .cordisx-navigation-menu-item[data-tone="danger"] { color:var(--color-text-danger,#ef6b73); }
    .cordisx-navigation-menu-item:disabled { opacity:.42; }
    .cordisx-navigation-confirm-backdrop { position:fixed; inset:0; z-index:2147483400; display:grid; place-items:center; padding:24px; background:rgba(0,0,0,.38); -webkit-app-region:no-drag; }
    .cordisx-navigation-confirm { width:min(380px,calc(100vw - 48px)); padding:18px; border:1px solid var(--color-border,rgba(127,127,127,.24)); border-radius:14px; background:var(--color-surface-elevated,var(--color-background-elevated,#272727)); color:var(--color-text,currentColor); box-shadow:0 18px 50px rgba(0,0,0,.36); }
    .cordisx-navigation-confirm-title { font:600 16px/22px system-ui,sans-serif; }
    .cordisx-navigation-confirm-description { margin-top:8px; color:var(--color-text-secondary,currentColor); font:400 13px/19px system-ui,sans-serif; }
    .cordisx-navigation-confirm-footer { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
    .cordisx-navigation-confirm-button { min-height:30px; padding:5px 12px; border:1px solid var(--color-border,rgba(127,127,127,.24)); border-radius:8px; background:transparent; color:inherit; }
    .cordisx-navigation-confirm-danger { border-color:transparent; background:var(--color-background-danger,#c33c48); color:#fff; }
    .cordisx-navigation-confirm-button:focus-visible { outline:2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset:2px; }
    .cordisx-navigation-feedback { position:fixed; left:50%; bottom:28px; z-index:2147483500; max-width:min(420px,calc(100vw - 32px)); transform:translateX(-50%); padding:8px 12px; border:1px solid var(--color-border,rgba(127,127,127,.24)); border-radius:9px; background:var(--color-surface-elevated,var(--color-background-elevated,#272727)); color:var(--color-text,currentColor); box-shadow:0 8px 24px rgba(0,0,0,.26); font:500 12px/17px system-ui,sans-serif; }
    .cordisx-navigation-feedback[data-tone="danger"] { color:var(--color-text-danger,#ef6b73); }
    @media (forced-colors:active) { .pg-sidebar .cxsi-row.cordisx-nav-row:hover, .pg-sidebar .cxsi-row.cordisx-nav-row:focus-within { background:Highlight; color:HighlightText; outline:1px solid Highlight; outline-offset:-1px; } .pg-sidebar .cxsi-row.cordisx-nav-row[data-selected="true"], .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="active"], .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="presented"] { background:Canvas; color:CanvasText; outline:1px solid Highlight; outline-offset:-1px; } .pg-sidebar .cxsi-row.cordisx-nav-row[data-selected="true"]:hover, .pg-sidebar .cxsi-row.cordisx-nav-row[data-selected="true"]:focus-within, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="active"]:hover, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="active"]:focus-within, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="presented"]:hover, .pg-sidebar .cxsi-row.cordisx-nav-row[data-cordisx-route-state="presented"]:focus-within { background:Highlight; color:HighlightText; } .cordisx-navigation-direct-action:hover:not(:disabled), .cordisx-navigation-more-action:hover:not(:disabled), .cordisx-navigation-direct-action[aria-pressed="true"] { background:Canvas; color:CanvasText; outline:1px solid Highlight; } }
    .cordisx-env-section { position: relative; z-index: 0; display: flex; width: 100%; min-width: 0; box-sizing: border-box; flex-direction: column; padding: 0 0 12px; background: transparent; color: inherit; }
    .cordisx-env-section:last-child { padding-bottom: 0; }
    .cordisx-env-section:not(:last-child)::after { content: ""; position: absolute; right: 14px; bottom: 0; left: 14px; height: .5px; background: var(--color-border,rgba(127,127,127,.18)); }
    .cordisx-env-header { position: sticky; top: 10px; z-index: 10; display: flex; width: 100%; min-width: 0; height: 28px; box-sizing: border-box; align-items: center; justify-content: flex-start; gap: 8px; padding: 0 10px 2px 14px; background: var(--color-surface-elevated-secondary,var(--color-background-elevated-secondary,inherit)); color: var(--color-text-tertiary,rgba(255,255,255,.5)); }
    .cordisx-env-header::before { content: ""; position: absolute; right: 0; bottom: 100%; left: 0; height: 10px; background: inherit; pointer-events: none; }
    .cordisx-env-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 400; line-height: 21px; }
    .cordisx-env-header-actions, .cordisx-env-row-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; }
    .cordisx-env-header-actions { margin-inline-start: auto; }
    .cordisx-env-row-actions { height: 20px; }
    .cordisx-env-content { display: flex; min-width: 0; box-sizing: border-box; flex-direction: column; gap: 2px; padding: 0 14px; }
    .cordisx-env-description { margin: 2px 0 4px; color: var(--color-text-tertiary,rgba(255,255,255,.5)); font-size: 13px; font-weight: 400; line-height: 18px; }
    .cordisx-env-row { display: flex; width: 100%; min-width: 0; min-height: 28px; box-sizing: border-box; align-items: center; gap: 4px; padding: 4px 0; font-size: 14px; line-height: 21px; }
    .cordisx-env-row-leading { display: inline-flex; width: 18px; height: 18px; flex: 0 0 18px; align-items: center; justify-content: flex-start; margin-inline-end: 8px; color: var(--color-text-secondary,currentColor); }
    .cordisx-env-row-label { display: flex; flex: 1 1 auto; min-width: 0; align-items: center; color: inherit; }
    .cordisx-env-row-copy { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-env-row-value { max-width: 50%; flex: 0 1 auto; overflow: hidden; color: var(--color-text-tertiary,rgba(255,255,255,.5)); font: inherit; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-action:not(.cordisx-native-icon-action) { display: inline-flex; align-items: center; gap: 6px; min-height: 27px; border: 1px solid transparent; border-radius: var(--radius-lg,10px); background: transparent; color: inherit; cursor: default; padding: 4px 7px; font: inherit; white-space: nowrap; user-select: none; -webkit-user-select: none; -webkit-app-region: no-drag; }
    .cordisx-native-icon-action { flex: 0 0 auto; -webkit-app-region: no-drag; }
    .cordisx-toolbar-before > .cordisx-toolbar-action, .cordisx-toolbar-after > .cordisx-toolbar-action, .cordisx-session-header-actions > .cordisx-toolbar-action { display: inline-flex; flex: 0 0 auto; width: var(--cordisx-toolbar-action-target-size); min-width: var(--cordisx-toolbar-action-target-size); height: var(--cordisx-toolbar-action-target-size); min-height: var(--cordisx-toolbar-action-target-size); align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--cordisx-toolbar-action-corner-radius); background-color: var(--cordisx-toolbar-action-idle-background); color: var(--color-text-tertiary,rgba(127,127,127,.78)); opacity: 1; cursor: default; white-space: nowrap; user-select: none; -webkit-user-select: none; }
    .cordisx-toolbar-before > .cordisx-toolbar-action:hover:not(:disabled), .cordisx-toolbar-after > .cordisx-toolbar-action:hover:not(:disabled), .cordisx-session-header-actions > .cordisx-toolbar-action:hover:not(:disabled), .cordisx-toolbar-before > .cordisx-toolbar-action[data-state="open"], .cordisx-toolbar-after > .cordisx-toolbar-action[data-state="open"], .cordisx-session-header-actions > .cordisx-toolbar-action[data-state="open"] { background-color: var(--cordisx-toolbar-action-hover-background); }
    .cordisx-toolbar-before > .cordisx-toolbar-action:focus, .cordisx-toolbar-after > .cordisx-toolbar-action:focus, .cordisx-session-header-actions > .cordisx-toolbar-action:focus { outline: none; }
    .cordisx-toolbar-before > .cordisx-toolbar-action:focus-visible, .cordisx-toolbar-after > .cordisx-toolbar-action:focus-visible, .cordisx-session-header-actions > .cordisx-toolbar-action:focus-visible { box-shadow: 0 0 0 2px var(--cordisx-toolbar-action-focus-ring); }
    .cordisx-toolbar-before > .cordisx-toolbar-action:disabled, .cordisx-toolbar-after > .cordisx-toolbar-action:disabled, .cordisx-session-header-actions > .cordisx-toolbar-action:disabled { cursor: default; opacity: var(--cordisx-toolbar-action-disabled-opacity); }
    .cordisx-toolbar-before > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"], .cordisx-toolbar-after > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"], .cordisx-session-header-actions > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"] { background-color: var(--cordisx-toolbar-action-pressed-background); color: var(--cordisx-toolbar-action-pressed-foreground); }
    .cordisx-toolbar-before > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"]:hover:not(:disabled), .cordisx-toolbar-after > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"]:hover:not(:disabled), .cordisx-session-header-actions > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"]:hover:not(:disabled), .cordisx-toolbar-before > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"][data-state="open"], .cordisx-toolbar-after > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"][data-state="open"], .cordisx-session-header-actions > .cordisx-toolbar-action[aria-pressed="true"][data-cordisx-route-state="presented"][data-state="open"] { background-color: var(--cordisx-toolbar-action-pressed-hover-background); }
    .cordisx-shortcut-action:not([class*="size-"]):not([class*="h-"]) { display: inline-flex; width: 24px; min-width: 24px; height: 24px; min-height: 24px; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius-lg,8px); background: transparent; color: var(--color-text-tertiary,rgba(255,255,255,.5)); }
    .cordisx-composer-action { display: inline-flex; flex: 0 0 auto; width: 28px; min-width: 28px; height: 28px; min-height: 28px; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: 9999px; background: transparent; color: var(--color-text-tertiary,currentColor); cursor: default; }
    .cordisx-composer-action:hover:not(:disabled), .cordisx-composer-action[data-state="open"] { background: var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); }
    .cordisx-composer-action:focus { outline: none; }
    .cordisx-composer-action:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: 0; }
    .cordisx-composer-action:disabled { cursor: default; opacity: .4; }
    .cordisx-host-icon { display: inline-flex; flex: 0 0 auto; width: 20px; height: 20px; align-items: center; justify-content: center; line-height: 0; pointer-events: none; user-select: none; -webkit-user-select: none; }
    .cordisx-host-icon svg { display: block; width: 20px; height: 20px; color: currentColor; pointer-events: none; }
    .cordisx-nav-primary > .cordisx-host-icon { width: 16px; height: 16px; }
    .cordisx-nav-primary > .cordisx-host-icon svg, .cordisx-shortcut-action .cordisx-host-icon, .cordisx-shortcut-action .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-icon-only-control { --cordisx-icon-only-glyph-size: 16px; }
    .cordisx-icon-only-control.cordisx-shortcut-action { --cordisx-icon-only-glyph-size: 12px; }
    .cordisx-icon-only-control .cordisx-host-icon svg { width: var(--cordisx-icon-only-glyph-size); height: var(--cordisx-icon-only-glyph-size); }
    .cordisx-composer-action .cordisx-host-icon, .cordisx-composer-action .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-native-menu-root { display: contents; }
    .cordisx-native-menu-item { -webkit-app-region: no-drag; }
    .cordisx-native-menu-row { display: flex; width: 100%; align-items: center; gap: 6px; }
    .cordisx-native-menu-row > .cordisx-host-icon { flex: 0 0 auto; opacity: .75; }
    .cordisx-native-menu-item:hover .cordisx-host-icon, .cordisx-native-menu-item:focus .cordisx-host-icon { opacity: 1; }
    .cordisx-native-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cordisx-surface-overflow { position: relative; display: inline-flex; flex: 0 0 auto; -webkit-app-region: no-drag; }
    .cordisx-surface-overflow > summary { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; border-radius: var(--radius-lg,8px); color: var(--color-text-tertiary,rgba(255,255,255,.5)); cursor: default; list-style: none; -webkit-app-region: no-drag; }
    .cordisx-surface-overflow > summary::-webkit-details-marker { display: none; }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary, .cordisx-toolbar-after > .cordisx-surface-overflow > summary, .cordisx-session-header-actions > .cordisx-surface-overflow > summary { width: var(--cordisx-toolbar-action-target-size); min-width: var(--cordisx-toolbar-action-target-size); height: var(--cordisx-toolbar-action-target-size); min-height: var(--cordisx-toolbar-action-target-size); padding: 0; border: 1px solid transparent; border-radius: var(--cordisx-toolbar-action-corner-radius); background-color: var(--cordisx-toolbar-action-idle-background); color: var(--color-text-tertiary,rgba(127,127,127,.78)); }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary:hover, .cordisx-toolbar-after > .cordisx-surface-overflow > summary:hover, .cordisx-session-header-actions > .cordisx-surface-overflow > summary:hover, .cordisx-toolbar-before > .cordisx-surface-overflow[open] > summary, .cordisx-toolbar-after > .cordisx-surface-overflow[open] > summary, .cordisx-session-header-actions > .cordisx-surface-overflow[open] > summary { background-color: var(--cordisx-toolbar-action-hover-background); }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary:focus, .cordisx-toolbar-after > .cordisx-surface-overflow > summary:focus, .cordisx-session-header-actions > .cordisx-surface-overflow > summary:focus { outline: none; }
    .cordisx-toolbar-before > .cordisx-surface-overflow > summary:focus-visible, .cordisx-toolbar-after > .cordisx-surface-overflow > summary:focus-visible, .cordisx-session-header-actions > .cordisx-surface-overflow > summary:focus-visible { box-shadow: 0 0 0 2px var(--cordisx-toolbar-action-focus-ring); }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary { width: 28px; height: 28px; border: 1px solid transparent; border-radius: 9999px; background: transparent; color: var(--color-text-tertiary,currentColor); }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary:hover, .cordisx-composer-submit-before > .cordisx-surface-overflow[open] > summary { background: var(--color-background-primary-ghost-hover,rgba(127,127,127,.12)); }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary:focus { outline: none; }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary:focus-visible { outline: 2px solid var(--color-ring,rgba(131,195,255,.76)); outline-offset: 0; }
    .cordisx-composer-submit-before > .cordisx-surface-overflow > summary .cordisx-host-icon, .cordisx-composer-submit-before > .cordisx-surface-overflow > summary .cordisx-host-icon svg { width: 16px; height: 16px; }
    .cordisx-surface-overflow-menu { position: absolute; z-index: 20; top: calc(100% + 4px); right: 0; display: grid; min-width: 160px; padding: 4px; border: 1px solid var(--color-border,rgba(255,255,255,.084)); border-radius: var(--radius-lg,10px); background: var(--color-background-elevated-secondary,#242424); box-shadow: 0 8px 28px rgba(0,0,0,.28); }
    .cordisx-surface-overflow:not([open]) > .cordisx-surface-overflow-menu { display: none; }
    .cordisx-env-header .cordisx-shortcut-action { --cordisx-icon-only-glyph-size: 18px; }
    .cordisx-env-header .cordisx-shortcut-action .cordisx-host-icon { width: 18px; height: 18px; }
    .cordisx-env-row-leading > .cordisx-host-icon, .cordisx-env-row-leading > .cordisx-host-icon svg { width: 18px; height: 18px; }
    .cordisx-env-row-actions .cordisx-shortcut-action { --cordisx-icon-only-glyph-size: 16px; }
  `
  ;(document.head ?? document.documentElement).append(style)
  const ownership: StructuredStyleOwnership = { element: style, references: 1 }
  structuredStyleOwnership.set(document, ownership)
  let released = false
  return () => {
    if (released) return
    released = true
    ownership.references -= 1
    if (ownership.references > 0) return
    style.remove()
    structuredStyleOwnership.delete(document)
  }
}

export { assertStructuredStyleOwnership, installStyles }
