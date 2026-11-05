const tokens: readonly (readonly [string, string, string?])[] = [
  ["color", "#111114", "#f4f4f6"],
  ["background", "#fff", "#17171c"],
  ["log-background", "#f2f2f4", "#0e0e12"],
  ["border", "#e4e4e8", "#2c2c34"],
  ["accent", "#111114", "#f4f4f6"],
  ["button-color", "#fff", "#111114"],
  ["bubble-background", "#fff", "#24242b"],
  ["input-background", "#fff", "#24242b"],
  ["focus", "#4f46e5", "#a5b4fc"],
  ["error", "#b91c1c", "#fca5a5"],
  ["approve", "#15803d"],
  ["approve-color", "#fff"],
  ["decline", "#b91c1c", "#dc2626"],
  ["decline-color", "#fff"],
  ["code-background", "rgb(0 0 0 / .06)", "rgb(255 255 255 / .1)"],
  ["face-background", "#1f1a3d", "#ffb547"],
  ["face-color", "#ffb547", "#1f1a3d"],
  ["face-dot", "#fff", "#1f1a3d"],
  ["presence", "#16a34a", "#4ade80"],
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
const darkTheme = `${declarations(true)}${controlBorder("#8e8e99")}color-scheme:dark;`;
export const baseStyles = `
[hidden] { display:none !important; }
.visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
textarea[data-auto-grow] { field-sizing:content; }
`;
export const defaultStyles = `
:host {
  ${declarations(false)}${controlBorder("#8e8e99")}
  --_panel-radius:var(--yada-panel-radius,var(--yada-radius,28px));
  --_card-radius:var(--yada-card-radius,var(--yada-radius,20px));
  --_control-radius:var(--yada-control-radius,var(--yada-radius,999px));
  --_field-radius:var(--yada-field-radius,var(--yada-radius,26px));
  --_bubble-radius:var(--yada-bubble-radius,20px);
  --_bubble-tail-radius:var(--yada-bubble-tail-radius,6px);
  --_code-radius:var(--yada-code-radius,6px);
  --_code-block-radius:var(--yada-code-block-radius,12px);
  --_spacing:var(--yada-spacing,16px);
  --_gap:var(--yada-gap,10px);
  --_code-font:var(--yada-code-font,ui-monospace,SFMono-Regular,Menlo,monospace);
  display:block; color:var(--_color); font:var(--yada-font,15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif);
}
:host([fill]) { height:100%; }
:host([color-scheme="dark"]) { ${darkTheme} }
@media (prefers-color-scheme: dark) { :host([color-scheme="auto"]) { ${darkTheme} } }
* { box-sizing:border-box; }
section { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--_log-background); border:1px solid var(--_border); border-radius:var(--_panel-radius); overflow:hidden; box-shadow:var(--yada-shadow,0 24px 60px -24px rgb(17 17 20 / .22),0 2px 6px rgb(17 17 20 / .04)); }
section > * { flex:none; }
header { display:flex; align-items:center; gap:var(--yada-header-gap,12px); padding:var(--yada-header-padding,12px var(--_spacing)); border-bottom:1px solid var(--_border); background:var(--yada-header-background,var(--_background)); color:var(--yada-header-color,inherit); }
.heading { min-width:0; }
h2 { font:var(--yada-title-font,inherit); font-size:var(--yada-title-size,1.0667em); font-weight:var(--yada-title-weight,600); line-height:1.25; letter-spacing:-.01em; margin:0; }
.subtitle { margin:0; font-size:.8667em; opacity:var(--yada-subtitle-opacity,.7); }
.avatar { position:relative; display:inline-flex; flex:none; align-items:center; justify-content:center; width:var(--yada-avatar-size,40px); height:var(--yada-avatar-size,40px); border-radius:var(--yada-avatar-radius,50%); font-weight:600; color:var(--yada-avatar-color,var(--_button-color)); background:var(--yada-avatar-background,var(--_accent)); }
.avatar img { display:block; width:100%; height:100%; object-fit:cover; border-radius:inherit; }
.avatar span:has(.face) { display:contents; }
:host([data-connection]) .avatar::after { content:""; position:absolute; right:0; bottom:0; width:25%; height:25%; border-radius:50%; background:var(--_presence); box-shadow:0 0 0 2px var(--yada-header-background,var(--_background)); }
:host([data-connection="disconnected"]) .avatar::after { background:var(--_control-border); }
.face { display:block; width:100%; height:100%; }
.face-background { fill:var(--_face-background); }
.face-features { fill:none; stroke:var(--_face-color); stroke-width:12; stroke-linecap:round; }
.face-dot { fill:var(--_face-dot); stroke:none; }
.face g { opacity:0; transition:opacity .25s ease; }
:host(:not([data-mood])) .face [data-mood="neutral"], :host([data-mood="neutral"]) .face [data-mood="neutral"], :host([data-mood="thinking"]) .face [data-mood="thinking"], :host([data-mood="smile"]) .face [data-mood="smile"], :host([data-mood="wink"]) .face [data-mood="wink"] { opacity:1; }
:host([data-mood="thinking"]) .avatar .face { animation:yada-think 1.6s infinite ease-in-out; }
@keyframes yada-think { 50% { transform:translateY(-2px); } }
.log { flex:1 1 auto; display:flex; flex-direction:column; gap:var(--_gap); height:var(--yada-log-height,360px); min-height:0; overflow:auto; overflow-wrap:anywhere; padding:var(--_spacing); }
.log > * { margin:0; max-width:var(--yada-bubble-max-width,80%); padding:var(--yada-bubble-padding,10px 14px); border-radius:var(--_bubble-radius); line-height:1.5; box-shadow:var(--yada-bubble-shadow,none); animation:yada-rise .18s ease-out; }
@keyframes yada-rise { from { transform:translateY(4px); } }
.log > .empty { animation:none; margin:auto; max-width:24em; padding:0; border-radius:0; line-height:inherit; box-shadow:none; text-align:center; }
.empty-avatar { display:block; width:var(--yada-empty-avatar-size,72px); height:var(--yada-empty-avatar-size,72px); margin:0 auto 14px; border-radius:var(--yada-avatar-radius,50%); overflow:hidden; font-size:1.75em; line-height:var(--yada-empty-avatar-size,72px); font-weight:600; color:var(--yada-avatar-color,var(--_button-color)); background:var(--yada-avatar-background,var(--_accent)); }
.empty-avatar img { display:block; width:100%; height:100%; object-fit:cover; }
.empty-text { margin:0; font-size:1.0667em; opacity:var(--yada-empty-opacity,.72); }
.suggestions { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin-top:16px; }
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
.remember { display:block; margin:8px 0 4px; font-size:.9em; }
.activity { margin:0 var(--_spacing) 10px; font-size:.875em; opacity:.75; }
.typing { position:relative; display:flex; gap:4px; align-self:flex-start; margin:0 var(--_spacing) 12px calc(var(--_spacing) + 34px); padding:13px 14px; width:max-content; border-radius:var(--_bubble-radius); border-bottom-left-radius:var(--_bubble-tail-radius); background:var(--_bubble-background); }
.typing-avatar { position:absolute; left:-34px; bottom:0; width:26px; height:26px; border-radius:var(--yada-avatar-radius,50%); overflow:hidden; font-size:.8em; line-height:26px; text-align:center; font-weight:600; color:var(--yada-avatar-color,var(--_button-color)); background:var(--yada-avatar-background,var(--_accent)); }
section:has(.typing-avatar[hidden]) .typing { margin-left:var(--_spacing); }
.typing-avatar img { display:block; width:100%; height:100%; object-fit:cover; }
.typing span[part="typing-dot"] { width:7px; height:7px; border-radius:50%; background:currentColor; opacity:.35; animation:yada-typing 1.2s infinite ease-in-out; }
.typing span:nth-child(3) { animation-delay:.15s; }
.typing span:nth-child(4) { animation-delay:.3s; }
@keyframes yada-typing { 0%, 60%, 100% { opacity:.35; transform:none; } 30% { opacity:.9; transform:translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .typing span[part="typing-dot"], .log > *, :host([data-mood="thinking"]) .avatar .face { animation:none; } .face g { transition:none; } }
[role="group"] { margin:0 var(--_spacing) 12px; padding:var(--yada-card-padding,14px 16px); border:1px solid var(--_border); border-radius:var(--_card-radius); background:var(--yada-card-background,var(--_background)); box-shadow:var(--yada-card-shadow,0 8px 24px -12px rgb(17 17 20 / .18)); }
:host([fill]) [role="group"] { max-height:50%; overflow:auto; }
h3 { font-size:1em; font-weight:600; margin:0 0 8px; }
form { position:relative; display:grid; grid-template-columns:1fr auto; gap:var(--_gap) 0; align-items:end; padding:var(--yada-composer-padding,12px var(--_spacing)); border-top:1px solid var(--_border); background:var(--yada-composer-background,var(--_background)); }
form::before { content:""; grid-area:1 / 1 / 2 / 3; align-self:stretch; background:var(--_input-background); border:1px solid var(--_control-border); border-radius:var(--_field-radius); box-shadow:var(--yada-input-shadow,none); }
form > * { position:relative; }
form > textarea { grid-area:1 / 1; }
textarea { display:block; width:100%; min-height:var(--yada-input-min-height,50px); max-height:var(--yada-input-max-height,160px); resize:vertical; font:inherit; font-size:max(16px,1em); color:inherit; background:transparent; border:0; border-radius:var(--_field-radius); padding:var(--yada-input-padding,13px 8px 13px 18px); }
textarea[data-auto-grow] { resize:none; }
button { font:inherit; font-weight:500; cursor:pointer; padding:var(--yada-button-padding,9px 18px); border:1px solid var(--_accent); border-radius:var(--_control-radius); color:var(--_button-color); background:var(--_accent); box-shadow:var(--yada-button-shadow,none); transition:filter .15s ease,transform .1s ease; }
button:not(:disabled):hover { filter:brightness(1.25); }
button:not(:disabled):active { transform:scale(.97); }
form button[type="submit"] { grid-area:1 / 2; margin:5px; }
form button[aria-label][type="submit"] { display:grid; place-items:center; width:40px; height:40px; padding:0; }
button.suggestion { padding:7px 14px; font-size:.9333em; color:inherit; background:var(--_bubble-background); border-color:var(--_control-border); }
button.approve { color:var(--_approve-color); background:var(--_approve); border-color:var(--yada-approve-border,var(--_approve)); }
button.decline { color:var(--_decline-color); background:var(--_decline); border-color:var(--yada-decline-border,var(--_decline)); }
button svg { display:block; width:1.25em; height:1.25em; fill:currentColor; }
[role="group"] button { margin:10px 8px 0 0; }
form button:not([type="submit"]) { grid-column:1 / -1; justify-self:start; color:inherit; background:transparent; border-color:var(--_control-border); }
button:disabled { opacity:var(--yada-disabled-opacity,.45); cursor:default; }
:focus-visible { outline:3px solid var(--_focus); outline-offset:2px; }
@supports selector(:has(*)) {
  textarea:focus-visible { outline:none; }
  form:has(textarea:focus-visible)::before { outline:3px solid var(--_focus); outline-offset:1px; }
}
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
  "--yada-field-radius",
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
  "--yada-empty-avatar-size",
  "--yada-bubble-max-width",
  "--yada-input-min-height",
  "--yada-input-max-height",
  "--yada-log-height",
  "--yada-subtitle-opacity",
  "--yada-empty-opacity",
  "--yada-disabled-opacity",
] as const;
