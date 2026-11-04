const tokens: readonly (readonly [string, string, string?])[] = [
  ["color", "#172033", "#e2e8f0"],
  ["background", "#fff", "#0f172a"],
  ["border", "#cbd5e1", "#334155"],
  ["accent", "#1d4ed8", "#2563eb"],
  ["button-color", "#fff"],
  ["bubble-background", "#f1f5f9", "#1e293b"],
  ["input-background", "#fff", "#1e293b"],
  ["focus", "#2563eb", "#60a5fa"],
  ["error", "#b91c1c", "#fca5a5"],
  ["approve", "#15803d"],
  ["approve-color", "#fff"],
  ["decline", "#b91c1c", "#dc2626"],
  ["decline-color", "#fff"],
  ["code-background", "rgb(0 0 0 / .06)", "rgb(255 255 255 / .1)"],
];
const declarations = (dark: boolean) =>
  tokens
    .map(([name, light, night]) => {
      const value = dark ? (night ?? light) : light;
      return `--_${name}:var(--yada-${name},${value});`;
    })
    .join("");
const controlBorder = (fallback: string) =>
  `--_control-border:var(--yada-control-border,var(--yada-border,${fallback}));`;
const darkTheme = `${declarations(true)}${controlBorder("#64748b")}color-scheme:dark;`;
export const baseStyles = `
[hidden] { display:none !important; }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
`;
export const defaultStyles = `
:host {
  ${declarations(false)}${controlBorder("#64748b")}
  --_panel-radius:var(--yada-panel-radius,var(--yada-radius,12px));
  --_card-radius:var(--yada-card-radius,var(--yada-radius,12px));
  --_control-radius:var(--yada-control-radius,var(--yada-radius,8px));
  --_bubble-radius:var(--yada-bubble-radius,18px);
  --_bubble-tail-radius:var(--yada-bubble-tail-radius,4px);
  --_code-radius:var(--yada-code-radius,5px);
  --_code-block-radius:var(--yada-code-block-radius,10px);
  --_spacing:var(--yada-spacing,16px);
  --_gap:var(--yada-gap,8px);
  --_code-font:var(--yada-code-font,ui-monospace,SFMono-Regular,Menlo,monospace);
  display:block; color:var(--_color); font:var(--yada-font,16px/1.5 system-ui,sans-serif);
}
:host([fill]) { height:100%; }
:host([color-scheme="dark"]) { ${darkTheme} }
@media (prefers-color-scheme: dark) { :host([color-scheme="auto"]) { ${darkTheme} } }
* { box-sizing:border-box; }
section { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--_background); border:1px solid var(--_border); border-radius:var(--_panel-radius); overflow:hidden; box-shadow:var(--yada-shadow,none); }
section > * { flex:none; }
header { display:flex; align-items:center; gap:var(--yada-header-gap,12px); padding:var(--yada-header-padding,12px var(--_spacing)); border-bottom:1px solid var(--_border); background:var(--yada-header-background,transparent); color:var(--yada-header-color,inherit); }
.heading { min-width:0; }
h2 { font:var(--yada-title-font,inherit); font-size:var(--yada-title-size,1em); font-weight:var(--yada-title-weight,bold); margin:0; }
.subtitle { margin:0; font-size:.875em; opacity:var(--yada-subtitle-opacity,.75); }
.avatar { display:inline-flex; flex:none; align-items:center; justify-content:center; width:var(--yada-avatar-size,32px); height:var(--yada-avatar-size,32px); border-radius:var(--yada-avatar-radius,50%); overflow:hidden; font-weight:600; color:var(--yada-avatar-color,var(--_button-color)); background:var(--yada-avatar-background,var(--_accent)); }
.avatar img { display:block; width:100%; height:100%; object-fit:cover; }
.log { flex:1 1 auto; display:flex; flex-direction:column; gap:var(--_gap); height:var(--yada-log-height,320px); min-height:0; overflow:auto; overflow-wrap:anywhere; padding:var(--_spacing); background:var(--yada-log-background,transparent); }
.log > * { margin:0; max-width:var(--yada-bubble-max-width,80%); padding:var(--yada-bubble-padding,10px 14px); border-radius:var(--_bubble-radius); line-height:1.55; box-shadow:var(--yada-bubble-shadow,none); }
.log > .empty { margin:auto; max-width:none; padding:0; border-radius:0; line-height:inherit; box-shadow:none; }
.empty-text { margin:0; opacity:var(--yada-empty-opacity,.65); }
.suggestions { display:flex; flex-wrap:wrap; gap:var(--_gap); justify-content:center; margin-top:12px; }
.suggestion { padding:6px 12px; font-size:.9em; color:inherit; background:transparent; }
.log > p { white-space:pre-wrap; }
.assistant > * { margin:0 0 .6em; }
.assistant > :last-child { margin-bottom:0; }
.assistant p { white-space:pre-wrap; }
.assistant ul, .assistant ol { padding-left:1.25em; }
.assistant li + li { margin-top:.25em; }
.assistant code { font-family:var(--_code-font); font-size:.9em; padding:1px 5px; border-radius:var(--_code-radius); background:var(--_code-background); }
.assistant pre.code { font-family:var(--_code-font); font-size:.875em; padding:10px 12px; border-radius:var(--_code-block-radius); background:var(--_code-background); overflow:auto; white-space:pre; }
.log .user { align-self:flex-end; color:var(--yada-user-bubble-color,var(--_button-color)); background:var(--yada-user-bubble-background,var(--_accent)); border-bottom-right-radius:var(--_bubble-tail-radius); }
.log .assistant { align-self:flex-start; color:var(--yada-assistant-bubble-color,inherit); background:var(--_bubble-background); border-bottom-left-radius:var(--_bubble-tail-radius); }
.error { margin:0; padding:0 var(--_spacing) 8px; font-size:.875em; }
.error:empty { padding:0; }
.remember { display:block; margin:0 0 4px; font-size:.9em; }
.activity { margin:0 var(--_spacing) 10px; font-size:.875em; }
.typing { display:flex; gap:4px; align-self:flex-start; margin:0 var(--_spacing) 10px; padding:12px 14px; width:max-content; border-radius:var(--_bubble-radius); border-bottom-left-radius:var(--_bubble-tail-radius); background:var(--_bubble-background); }
.typing span { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.35; animation:yada-typing 1.2s infinite ease-in-out; }
.typing span:nth-child(2) { animation-delay:.15s; }
.typing span:nth-child(3) { animation-delay:.3s; }
@keyframes yada-typing { 0%, 60%, 100% { opacity:.35; transform:none; } 30% { opacity:.9; transform:translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .typing span { animation:none; } }
[role="group"] { margin:0 var(--_spacing) 12px; padding:var(--yada-card-padding,12px 16px); border:1px solid var(--_border); border-radius:var(--_card-radius); background:var(--yada-card-background,transparent); box-shadow:var(--yada-card-shadow,none); }
:host([fill]) [role="group"] { max-height:50%; overflow:auto; }
h3 { font-size:1em; margin:0 0 8px; }
form { display:grid; grid-template-columns:1fr auto; gap:var(--_gap); align-items:end; padding:var(--yada-composer-padding,12px var(--_spacing)); border-top:1px solid var(--_border); background:var(--yada-composer-background,transparent); }
textarea { display:block; width:100%; min-height:var(--yada-input-min-height,48px); max-height:var(--yada-input-max-height,160px); resize:vertical; font:inherit; color:inherit; background:var(--_input-background); border:1px solid var(--_control-border); border-radius:var(--_control-radius); padding:var(--yada-input-padding,12px 14px); box-shadow:var(--yada-input-shadow,none); }
textarea[data-auto-grow] { resize:none; }
button { font:inherit; cursor:pointer; padding:var(--yada-button-padding,10px 18px); border:1px solid var(--_control-border); border-radius:var(--_control-radius); color:var(--_button-color); background:var(--_accent); box-shadow:var(--yada-button-shadow,none); }
button.suggestion { padding:6px 12px; color:inherit; background:transparent; }
button.approve { color:var(--_approve-color); background:var(--_approve); border-color:var(--yada-approve-border,var(--_approve)); }
button.decline { color:var(--_decline-color); background:var(--_decline); border-color:var(--yada-decline-border,var(--_decline)); }
button svg { display:block; width:1.25em; height:1.25em; fill:currentColor; }
[role="group"] button { margin:8px 8px 0 0; }
form button:not([type="submit"]) { grid-column:1 / -1; justify-self:start; }
button:disabled { opacity:var(--yada-disabled-opacity,.6); cursor:default; }
:focus-visible { outline:3px solid var(--_focus); outline-offset:3px; }
pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; margin:0; }
.error { color:var(--_error); }
`;
export const cssVariables = [
  ...tokens.map(([name]) => `--yada-${name}`),
  "--yada-control-border",
  "--yada-font",
  "--yada-code-font",
  "--yada-title-font",
  "--yada-title-size",
  "--yada-title-weight",
  "--yada-radius",
  "--yada-panel-radius",
  "--yada-card-radius",
  "--yada-control-radius",
  "--yada-bubble-radius",
  "--yada-bubble-tail-radius",
  "--yada-code-radius",
  "--yada-code-block-radius",
  "--yada-avatar-radius",
  "--yada-spacing",
  "--yada-gap",
  "--yada-header-gap",
  "--yada-header-padding",
  "--yada-bubble-padding",
  "--yada-card-padding",
  "--yada-composer-padding",
  "--yada-input-padding",
  "--yada-button-padding",
  "--yada-shadow",
  "--yada-bubble-shadow",
  "--yada-card-shadow",
  "--yada-input-shadow",
  "--yada-button-shadow",
  "--yada-header-background",
  "--yada-header-color",
  "--yada-log-background",
  "--yada-composer-background",
  "--yada-card-background",
  "--yada-user-bubble-background",
  "--yada-user-bubble-color",
  "--yada-assistant-bubble-color",
  "--yada-avatar-background",
  "--yada-avatar-color",
  "--yada-approve-border",
  "--yada-decline-border",
  "--yada-avatar-size",
  "--yada-bubble-max-width",
  "--yada-input-min-height",
  "--yada-input-max-height",
  "--yada-log-height",
  "--yada-subtitle-opacity",
  "--yada-empty-opacity",
  "--yada-disabled-opacity",
] as const;
