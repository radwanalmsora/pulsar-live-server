# ⚡ Pulsar Live Server

**The fastest way to preview your web projects.** Zero dependencies, instant reload, and built-in tools modern front-end developers actually need.

## Why Pulsar?

| Feature | Pulsar | Classic live servers |
|---|:-:|:-:|
| Instant live reload (SSE, no WebSocket lib) | ✅ | ✅ |
| **CSS hot-injection** (no page refresh) | ✅ | ❌ |
| **Live update while typing** (no save needed) | ✅ | ❌ |
| **Scroll position preserved** after reload | ✅ | ❌ |
| **On-page JS error toasts** | ✅ | ❌ |
| **SPA mode** (React/Vue/Angular routes) | ✅ | ❌ |
| **Reverse proxy** incl. WebSockets | ✅ | ⚠️ |
| HTTPS, CORS, custom headers | ✅ | ⚠️ |
| Phone testing over Wi-Fi + URL picker | ✅ | ⚠️ |
| Auto port fallback if port is busy | ✅ | ❌ |
| HTTP range requests (video seeking) | ✅ | ❌ |
| Multi-root workspaces | ✅ | ✅ |
| Zero runtime dependencies | ✅ | ❌ |

## Usage
- Click **Go Live** in the status bar, or press `Ctrl+Alt+L` (`Cmd+Alt+L` on Mac).
- Right-click any `.html` file → **Open with Pulsar Live Server** (`Ctrl+Alt+O`).
- `Ctrl+Alt+U` → show local & network URLs (copy to open on your phone).

## Settings (`pulsar.*`)
`port`, `root`, `host`, `browser`, `browserArgs`, `openOnStart`, `reloadOnType`, `debounce`, `cssInjection`, `ignoreFiles`, `injectTag`, `spa`, `directoryListing`, `cors`, `headers`, `https`, `proxy`, `notifications`.

### Examples
```jsonc
{
  "pulsar.host": "0.0.0.0",            // test on your phone
  "pulsar.reloadOnType": true,         // update without saving
  "pulsar.spa": true,                  // React/Vue routers
  "pulsar.proxy": [{ "path": "/api", "target": "http://localhost:3000" }],
  "pulsar.https": { "enable": true, "cert": "/path/cert.pem", "key": "/path/key.pem" },
  "pulsar.browser": "chrome",
  "pulsar.browserArgs": ["--incognito"]
}
```

## Build the VSIX
Push to GitHub — the **Build VSIX** workflow runs checks and uploads `pulsar-live-server.vsix` as an artifact. Push a tag like `v1.0.0` to also create a GitHub Release (and publish if `VSCE_PAT` is set).

Local build: `npm test && npm run package`

## License
MIT
