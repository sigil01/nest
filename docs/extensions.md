# Workspace Extensions

Extensions add custom UI to the nest workspace — dashboard panels, toolbar buttons, sidebar sections, and more. Each extension runs in a **sandboxed iframe** and communicates with the host via `postMessage`. Extensions cannot access the host page's DOM, cookies, sessionStorage, or auth tokens.

## Quick Start

1. Create an extension directory:
   ```
   ~/extensions/hello-world/
   ├── manifest.yaml
   └── panel.js
   ```

2. Add a manifest:
   ```yaml
   id: hello-world
   name: Hello World
   version: 1
   slots:
       - type: dashboard
         entry: panel.js
         defaultHeight: 80
   ```

3. Write your entry script:
   ```js
   // nest is a global provided by /nest-sdk.js (loaded automatically)

   var div = document.createElement('div');
   div.style.padding = '1rem';
   div.innerHTML = '<h3>👋 Hello from an extension!</h3>';
   document.body.appendChild(div);

   // Tell the host how tall your content is
   nest.resize(document.body.scrollHeight);
   ```

4. Refresh the workspace page.

## Configuration

Add to `config.yaml`:

```yaml
extensions:
    dir: /home/wren/extensions
```

Each subdirectory of `extensions.dir` with a valid `manifest.yaml` is loaded as an extension.

## Manifest Format

```yaml
id: my-ext              # Unique identifier (used in API paths)
name: My Extension      # Display name
version: 1              # Integer version
slots:                  # UI slots this extension renders into
    - type: dashboard   # Where: dashboard, sidebar, toolbar, viewer
      entry: panel.js   # JS entry point (relative to extension dir)
      defaultHeight: 150  # Optional initial iframe height in px
    - type: sidebar
      entry: sidebar.js
```

An extension can declare multiple slots. Each slot creates its own sandboxed iframe with its own entry script.

### Slot Types

| Type | Where it renders | Notes |
|------|-----------------|-------|
| `dashboard` | Dashboard grid, after built-in panels | `defaultHeight` recommended |
| `sidebar` | Below the file browser in the sidebar | |
| `toolbar` | Top bar, before the Chat toggle | Keep height small (~32px) |
| `viewer` | (Future) Custom file viewer | Not yet implemented |

## Extension SDK

The host automatically loads `/nest-sdk.js` before your extension script. It provides a global `nest` object with a Promise-based API over `postMessage`:

```js
// nest is available as a global — no import needed
nest.fetch('/api/status').then(console.log);
```

### `nest.fetch(url, init?)`

Proxied fetch through the host. The host adds auth credentials — the extension never sees the token. **Only `/api/` paths are allowed** — requests to other URLs are rejected.

```js
const result = await nest.fetch('/api/status');
// result = { status: 200, ok: true, body: { uptime: 12345, ... } }
```

### `nest.readFile(root, path)`

Read a file from a configured file root.

```js
const file = await nest.readFile('vault', 'notes.md');
```

### `nest.writeFile(root, path, content)`

Write content to a file.

```js
await nest.writeFile('vault', 'notes.md', 'Updated content');
```

### `nest.state.get(key)` / `nest.state.set(key, value)`

Persistent key-value state, stored by the host on the extension's behalf. State is **scoped per extension** — each extension has its own isolated namespace. Extensions in sandboxed iframes can't access `localStorage` directly.

```js
await nest.state.set('lastRun', Date.now());
const lastRun = await nest.state.get('lastRun');
```

### `nest.on(eventName, callback)`

Listen for events pushed from the host.

```js
nest.on('fileSelected', ({ path, root }) => {
    console.log('File selected:', path);
});
```

### `nest.resize(height)`

Tell the host to resize this extension's iframe to the given height in pixels.

```js
nest.resize(document.body.scrollHeight);
```

### Theme Integration

The host posts CSS custom property values into the iframe on load and on theme changes. The SDK automatically applies them to `document.documentElement`, so you can use them in your CSS:

```css
.my-panel {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border);
}
```

Available variables: `--bg-primary`, `--bg-secondary`, `--bg-tertiary`, `--text-primary`, `--text-secondary`, `--accent`, `--accent-hover`, `--border`, `--error`, `--success`.

## Security Model

Each extension runs in an `<iframe sandbox="allow-scripts">` **without** `allow-same-origin`. This gives the iframe an [opaque origin](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe#sandbox), which means:

- **No access to host DOM** — `window.parent` is inaccessible
- **No access to cookies** — the extension can't read or set cookies
- **No access to sessionStorage/localStorage** — opaque origin gets its own empty storage
- **No access to auth tokens** — API calls are proxied through the host bridge

All communication happens through `postMessage`. The host-side `ExtensionBridge` validates every message and proxies API calls with proper authentication. The bridge only responds to messages from **registered extension iframes** — messages from other windows are silently ignored.

Additional protections:
- **Fetch restricted to `/api/` paths** — extensions cannot proxy requests to arbitrary external URLs
- **State scoped per extension** — each extension's key-value state is isolated by extension ID
- **30-second request timeout** — SDK requests that receive no reply are automatically rejected

### Message Protocol

Extensions don't need to use the raw protocol — the SDK handles it. But for reference:

```
Extension → Host:
  { type: "nest", id: "<uuid>", action: "fetch", args: { url: "/api/status" } }
  { type: "nest-resize", height: 320 }

Host → Extension:
  { type: "nest-reply", id: "<uuid>", result: { ... } }
  { type: "nest-reply", id: "<uuid>", error: "..." }
  { type: "nest-event", name: "fileSelected", detail: { ... } }
  { type: "nest-theme", vars: { "--bg-primary": "#1e1e2e", ... } }
```

## Example

See `examples/extensions/hello-world/` for a minimal working extension with a dashboard panel.

## Tips

- **Extensions own their document.** There's no `render(container)` callback — you write directly to `document.body`. Use vanilla JS, Preact, Lit, or anything that runs in a browser.
- **No build step required.** Extensions are served as plain scripts. The `nest` object is a global — no `import` statement needed.
- **Auto-sizing.** Call `nest.resize()` after rendering or when content changes. The host sets `defaultHeight` from the manifest as the initial size.
- **Error isolation.** Each extension loads in its own iframe. A broken extension can't crash others or the host.
- **Refresh to reload.** Extensions load at page startup. Edit files, refresh the page.
