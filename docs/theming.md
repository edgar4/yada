---
layout: doc
title: "Widget theming"
description: "Rename and restyle Yada's chat widget: every option, CSS part, variable, slot, render hook and event, with a live restyled example."
---

# Widget theming

With no options the widget is a monochrome chat window with Yada's face in the header. Her face changes with the run. Everything here is opt-in, and nothing depends on the widget's internal HTML.

<div class="widget-demo" data-widget-demo>
  <div class="widget-demo-tabs" role="group" aria-label="Demo theme">
    <button type="button" data-theme="default" aria-pressed="true">Default</button>
    <button type="button" data-theme="moss" aria-pressed="false">Moss</button>
    <button type="button" data-theme="console" aria-pressed="false">Console</button>
  </div>
  <div class="widget-demo-frame"><yada-chat></yada-chat></div>
  <p class="widget-demo-note">A scripted demo in your browser. No model or server is involved. Ask anything to see a reply, a tool call and an approval.</p>
</div>
<script src="assets/yada-widget.js" defer></script>
<script src="assets/widget-demo.js" defer></script>

## A renamed, restyled example

The same element, turned into another product's assistant. The full source is in [`examples/browser/moss.ts`](https://github.com/edgar4/yada/blob/main/examples/browser/moss.ts).

```ts
widget.configure({
  client,
  conversationId,
  profileId: "garden",
  name: "Moss",
  subtitle: "Your garden helper",
  fill: true,
  colorScheme: "auto",
  suggestions: ["What can I plant now?", "Book a soil test"],
  labels: { approve: "Yes, book it", decline: "Not now" },
  formatApprovalPreview: (preview) =>
    preview.replace(/^(\w+):/gm, (_, field: string) => `${friendly(field)}:`),
  renderActivity: ({ tool, phase }) =>
    phase === "started" ? `Checking ${tool}…` : null,
  styles: `
    :host {
      --yada-accent: #3a5a1c;
      --yada-button-color: #fffdf5;
      --yada-background: #fffdf5;
      --yada-log-background: #f1efdf;
      --yada-bubble-background: #fffdf5;
      --yada-color: #27331a;
      --yada-title-font: 600 19px/1.2 Georgia, serif;
      --yada-title-size: 19px;
      --yada-face-background: #3a5a1c;
      --yada-face-color: #f5e9b8;
      --yada-face-dot: #f5e9b8;
    }
  `,
});
```

Options can also come from outside the shadow root:

```css
yada-chat::part(header) {
  background: #ecfccb;
}
yada-chat::part(send) {
  border-radius: 50%;
}
yada-chat[data-state="awaiting-approval"]::part(composer) {
  opacity: 0.6;
}
```

## Options

All are optional and passed to `configure`, next to `client`, `conversationId` and `profileId`.

| Option                  | Type                                             | Default     | What it does                                                                                                                    |
| ----------------------- | ------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | `string`                                         | `"Yada"`    | The agent's name. Also the `name` attribute, which can change at any time. See [Naming](#naming).                               |
| `subtitle`              | `string`                                         | none        | A line under the title.                                                                                                         |
| `avatar`                | `{ image: url } \| { text: string } \| false`    | Yada's face | An image or text avatar, or `false` for none. It also appears in the empty state. It is decorative; the title carries the name. |
| `header`                | `boolean`                                        | `true`      | `false` hides the header and moves the title to the root's accessible name.                                                     |
| `fill`                  | `boolean`                                        | off         | Fill the container's height. Also the `fill` attribute. See [Layout](#layout).                                                  |
| `colorScheme`           | `"light" \| "dark" \| "auto"`                    | `"light"`   | Built-in dark colors, or `auto` to follow `prefers-color-scheme`. Also the `color-scheme` attribute.                            |
| `styles`                | `string \| CSSStyleSheet`                        | none        | CSS applied inside the shadow root after the defaults.                                                                          |
| `unstyled`              | `boolean`                                        | `false`     | Drop the default styles. Only what accessibility needs stays: `hidden` and visually hidden text.                                |
| `composer.autoGrow`     | `boolean`                                        | `true`      | Start at one line and grow the input with its text, up to `--yada-input-max-height`.                                            |
| `composer.send`         | `"text" \| "icon"`                               | `"icon"`    | `icon` shows an icon, or the `send-icon` slot, and keeps the `send` label as the accessible name.                               |
| `composer.enter`        | `"send" \| "newline"`                            | `"send"`    | `send`: Enter sends, Shift+Enter adds a line. `newline`: Enter adds a line, Ctrl/Cmd+Enter sends.                               |
| `suggestions`           | `(string \| { label, text })[]`                  | none        | Starter prompts in the empty state. Clicking one sends it.                                                                      |
| `labels`                | `Partial<WidgetLabels>`                          | English     | Reword or translate any string. `{name}` works in all of them.                                                                  |
| `renderMessage`         | `(message, helpers) => Node \| string`           | none        | Render a message's content. See [Render hooks](#render-hooks).                                                                  |
| `renderApproval`        | `(approval, actions, helpers) => Node`           | none        | Render the approval card's content.                                                                                             |
| `renderActivity`        | `(activity, helpers) => Node \| string`          | none        | Show tool activity, which is otherwise only announced to screen readers.                                                        |
| `formatApprovalPreview` | `(preview, approval, helpers) => Node \| string` | none        | Turn raw previews such as `firstName: Testy` into friendly text.                                                                |

### Naming

`{name}` in any label is replaced with the name, which defaults to `Yada`. Setting a name also switches these default labels to use it:

| Label                   | Without a name                                 | With a name                                        |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `title`                 | `{name}`                                       | `{name}`                                           |
| `placeholder`           | empty                                          | Message `{name}`                                   |
| `message`               | Message                                        | Message `{name}`                                   |
| `conversation`          | Conversation                                   | Conversation with `{name}`                         |
| `empty`                 | Send a message to start the conversation.      | Send `{name}` a message to start the conversation. |
| `errorDependencyFailed` | A service the assistant depends on failed.     | A service `{name}` depends on failed.              |
| `errorRefused`          | The assistant declined to answer this request. | `{name}` declined to answer this request.          |

An explicit label always wins.

## Parts

Part names are public API under semver: removing or renaming one is a breaking change. `widgetParts` exports the list. Style them with `yada-chat::part(name)`.

| Part                                    | Element                                            |
| --------------------------------------- | -------------------------------------------------- |
| `root`                                  | The outer panel                                    |
| `header`, `avatar`, `title`, `subtitle` | The header and its contents                        |
| `log`                                   | The scrolling conversation                         |
| `empty`, `empty-avatar`, `empty-text`   | The empty state, its avatar and its text           |
| `suggestions`, `suggestion`             | Starter prompts                                    |
| `message`                               | Every message. Each also has `user` or `assistant` |
| `user`, `assistant`                     | Messages by sender                                 |
| `code`, `code-block`                    | Code in assistant replies                          |
| `activity`                              | Tool activity from `renderActivity`                |
| `typing`, `typing-avatar`, `typing-dot` | The typing indicator                               |
| `status`                                | The visually hidden status line                    |
| `error`                                 | The alert line                                     |
| `approval`                              | The approval card                                  |
| `approval-title`, `approval-preview`    | Its heading and preview                            |
| `remember`, `remember-input`            | The remember control and its checkbox              |
| `approve`, `decline`                    | The decision buttons                               |
| `above-composer`                        | The wrapper of the `above-composer` slot           |
| `composer`, `input`                     | The form and its text field                        |
| `send`, `stop`, `retry`                 | The composer's buttons                             |
| `footer`                                | The wrapper of the `footer` slot                   |

### Inside your own component

If `yada-chat` sits in another component's shadow root, forward its parts with `exportparts`:

```ts
import { widgetExportParts } from "@edgaralochi/yada/widget";
chat.setAttribute("exportparts", widgetExportParts);
```

Then `my-shell::part(send)` reaches the button.

## State

The host carries its state, so CSS can respond to it:

| Attribute         | Values                                                      |
| ----------------- | ----------------------------------------------------------- |
| `data-state`      | `idle`, `running`, `awaiting-approval`, `error`             |
| `data-connection` | `connected`, `disconnected`                                 |
| `data-mood`       | `neutral`, `thinking`, `wink` (approval), `smile` (replied) |

The default face reads `data-mood`. To use your own faces, slot an image and swap it from this attribute, or set `avatar` to keep one picture.

## CSS variables

Set them on the element or in `styles`. Dark mode changes the defaults of the colors, and a value you set wins in both modes.

### Colors

When you set `--yada-accent`, set `--yada-button-color` too. Dark mode's default button text is dark, to sit on its light accent.

| Variable                                                                           | Default                      | Dark                            |
| ---------------------------------------------------------------------------------- | ---------------------------- | ------------------------------- |
| `--yada-color`                                                                     | `#172033`                    | `#e2e8f0`                       |
| `--yada-background`                                                                | `#fff`                       | `#0f172a`                       |
| `--yada-border`                                                                    | `#cbd5e1`                    | `#334155`                       |
| `--yada-control-border`                                                            | `--yada-border`, `#64748b`   | same                            |
| `--yada-accent`                                                                    | `#1d4ed8`                    | `#2563eb`                       |
| `--yada-button-color`                                                              | `#fff`                       | same                            |
| `--yada-bubble-background`                                                         | `#f1f5f9`                    | `#1e293b`                       |
| `--yada-input-background`                                                          | `#fff`                       | `#1e293b`                       |
| `--yada-focus`                                                                     | `#2563eb`                    | `#60a5fa`                       |
| `--yada-error`                                                                     | `#b91c1c`                    | `#fca5a5`                       |
| `--yada-approve`, `--yada-approve-color`, `--yada-approve-border`                  | `#15803d`, `#fff`, approve   | same                            |
| `--yada-decline`, `--yada-decline-color`, `--yada-decline-border`                  | `#b91c1c`, `#fff`, decline   | `#dc2626`, `#fff`               |
| `--yada-code-background`                                                           | `rgb(0 0 0 / .06)`           | `rgb(255 255 255 / .1)`         |
| `--yada-user-bubble-background`, `--yada-user-bubble-color`                        | accent, button color         | same                            |
| `--yada-assistant-bubble-color`, `--yada-header-color`                             | inherited                    | same                            |
| `--yada-log-background`                                                            | `#f2f2f4`                    | `#0e0e12`                       |
| `--yada-face-background`, `--yada-face-color`, `--yada-face-dot`                   | `#1f1a3d`, `#ffb547`, `#fff` | `#ffb547`, `#1f1a3d`, `#1f1a3d` |
| `--yada-presence`                                                                  | `#16a34a`                    | `#4ade80`                       |
| `--yada-header-background`, `--yada-composer-background`, `--yada-card-background` | background                   | same                            |
| `--yada-avatar-background`, `--yada-avatar-color`                                  | accent, button color         | same                            |

### Radius

| Variable                                            | Default                       |
| --------------------------------------------------- | ----------------------------- |
| `--yada-radius`                                     | Sets panel, card and controls |
| `--yada-panel-radius`, `--yada-card-radius`         | `12px`                        |
| `--yada-control-radius`                             | `999px`                       |
| `--yada-field-radius`                               | `26px`                        |
| `--yada-bubble-radius`, `--yada-bubble-tail-radius` | `18px`, `4px`                 |
| `--yada-code-radius`, `--yada-code-block-radius`    | `5px`, `10px`                 |
| `--yada-avatar-radius`                              | `50%`                         |

### Spacing and size

| Variable                                                                    | Default                         |
| --------------------------------------------------------------------------- | ------------------------------- |
| `--yada-spacing`                                                            | `16px`                          |
| `--yada-gap`, `--yada-header-gap`                                           | `8px`, `12px`                   |
| `--yada-header-padding`, `--yada-composer-padding`                          | `12px` and the spacing          |
| `--yada-bubble-padding`, `--yada-input-padding`                             | `10px 14px`, `12px 14px`        |
| `--yada-card-padding`, `--yada-button-padding`                              | `12px 16px`, `10px 18px`        |
| `--yada-avatar-size`, `--yada-empty-avatar-size`, `--yada-bubble-max-width` | `40px`, `72px`, `80%`           |
| `--yada-input-min-height`, `--yada-input-max-height`                        | `48px`, `160px`                 |
| `--yada-log-height`                                                         | `320px`. Not needed with `fill` |

### Fonts, shadows and opacity

| Variable                                                                                                     | Default                          |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `--yada-font`                                                                                                | `16px/1.5 system-ui, sans-serif` |
| `--yada-code-font`                                                                                           | A monospace stack                |
| `--yada-title-font`, `--yada-title-size`, `--yada-title-weight`                                              | Inherited, `1em`, bold           |
| `--yada-shadow`, `--yada-bubble-shadow`, `--yada-card-shadow`, `--yada-input-shadow`, `--yada-button-shadow` | `none`                           |
| `--yada-subtitle-opacity`, `--yada-empty-opacity`, `--yada-disabled-opacity`                                 | `.75`, `.65`, `.6`               |

`cssVariables` exports the list. If you change colors, check their contrast yourself.

## Layout

```html
<div style="height: 100vh"><yada-chat fill></yada-chat></div>
```

With `fill` the host is `height: 100%`, the log takes the remaining space and scrolls, and the composer stays in view. A long approval card is capped at half the height and scrolls. Giving the host any height of your own has the same effect. Without either, the log keeps its `--yada-log-height`.

## Slots

| Slot             | Where                                                      |
| ---------------- | ---------------------------------------------------------- |
| `header`         | Replaces the header's contents                             |
| `avatar`         | Replaces the avatar                                        |
| `empty`          | Replaces the empty state's text. Suggestions stay below it |
| `above-composer` | Between the conversation and the composer                  |
| `footer`         | Under the composer                                         |
| `send-icon`      | Replaces the icon when `composer.send` is `icon`           |

```html
<yada-chat>
  <img slot="avatar" src="/moss.png" alt="" />
  <small slot="footer">Moss can make mistakes. Check important details.</small>
</yada-chat>
```

Slotted content is yours: it lives in your document and takes your styles.

## Render hooks

Hooks return DOM nodes or a string, and a string is always shown as text. Returning `null` or `undefined` keeps the default. If a hook throws, the widget uses the default and emits `yada-error` with `kind: "render"`, so a bad hook can't break a run or blank an approval.

```ts
renderMessage: ({ role, text, streaming }, { markdown }) => {
  const box = document.createElement("div");
  box.className = streaming ? "live" : "done";
  box.append(role === "assistant" ? markdown(text) : text);
  return box;
};
```

`helpers.markdown(text)` is the widget's own safe renderer and `helpers.text(text)` makes a text node.

**Model output is untrusted.** Build nodes with `textContent`, `append` or `helpers.markdown`. Never pass it to `innerHTML`: the browser can run an injected `onerror` while parsing, before the widget sees the node. As a second layer, everything a hook returns is cleaned before it is added. Scripts, frames, embeds, `style` and `template` elements, `on*` attributes and `srcdoc` are removed, as are URLs that aren't `http`, `https`, `mailto`, `tel`, `blob` or `data:image`. Listeners you add with `addEventListener` keep working. There is no way to turn this off.

The widget keeps each message's role, its part and the hidden "You:" prefix for screen readers. Your node goes inside.

`renderApproval` gets `approval` (`id`, `preview`, `status`, `expiresAt`, `remember`) and `actions`:

```ts
renderApproval: (approval, actions) => {
  const yes = document.createElement("button");
  yes.textContent = "Book it";
  yes.disabled = actions.disabled;
  yes.addEventListener("click", () => {
    actions.approve({ remember: false });
  });
  const no = document.createElement("button");
  no.textContent = "Not now";
  no.disabled = actions.disabled;
  no.addEventListener("click", actions.decline);
  const box = document.createElement("div");
  box.append(approval.preview, yes, no);
  return box;
};
```

The card keeps its `group` role and name. Focus moves to its first focusable element, or to the card if there is none. `actions.approve` and `actions.decline` do nothing once a decision can no longer be made. Show users what will really happen: the widget can't check that your text matches the action.

`renderActivity` gets `{ tool, phase: "started" | "finished", failed }`. Its output clears when text arrives or the run moves on.

## Events

All bubble and cross the shadow boundary. `WidgetEventMap` has their types.

| Event                   | When                                | `detail`                                                    |
| ----------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `yada-ready`            | Configured and connected            | `{ conversationId }`                                        |
| `yada-run`              | A run is about to start             | `{ conversationId, runId }`                                 |
| `yada-message`          | The user sent a message             | `{ conversationId, runId, text, steering }`                 |
| `yada-approval`         | An approval is shown                | `{ conversationId, runId, approvalId, preview }`            |
| `yada-approval-decided` | The server accepted a decision      | `{ conversationId, runId, approvalId, approved, remember }` |
| `yada-run-end`          | The run reached a terminal state    | `{ conversationId, runId, status }`                         |
| `yada-error`            | An error was shown or a hook failed | `{ conversationId, runId?, kind, code?, message }`          |

`kind` is `run`, `connection`, `load`, `cancel`, `decision`, `steer` or `render`. A resumed run that no longer exists is not an error and emits nothing.

## Accessibility

These hold in every mode, including `unstyled`:

- The log, status line, alert, group and field keep their roles and names.
- Hidden text stays available to assistive technology: the composer label, "You:" and the status line. An icon-only send button keeps its name, and a hidden header leaves its title on the root.
- Focus moves to an approval when it appears, and back to the composer when a run ends.
- The typing animation stops under `prefers-reduced-motion`.

If you hide text with your own CSS, hide it visually, not with `display: none`, or give the control an accessible name through `labels`.

## Content Security Policy

`styles` strings use constructed stylesheets, like the defaults, so a `style-src` without `'unsafe-inline'` allows them. Avatar images need `img-src`.
