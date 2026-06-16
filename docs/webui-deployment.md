# WebUI Deployment

The `webui` module is a plain HTTP + WebSocket server. It owns no
TLS, no outer authentication, no certificate management. Those are the
reverse proxy's job. This is intentional — it keeps the host code small
and lets the deployer pick whatever auth and cert mechanism the org
already uses.

This guide covers the typical deployment shape: a remote VM accessed
over a VPN, with Caddy fronting the host process.

## Module config

In your recipe:

```json
{
  "modules": {
    "webui": {
      "port": 7340,
      "host": "127.0.0.1"
    }
  }
}
```

The defaults are `0.0.0.0:7340` — connectome deployments are remote, not
local, so the module binds all interfaces by default. Because that is a
non-loopback bind, the module **refuses to start unless `basicAuth` is
configured**: any recipe that enables webui must supply credentials. There
is no unauthenticated escape hatch — even behind a reverse proxy, app-level
Basic-Auth is required. Set `host: "127.0.0.1"` to bind loopback-only for
local development, which skips the auth requirement.

Front the module with a reverse proxy (Caddy/nginx) to terminate TLS; the
proxy handles transport security while Basic-Auth gates the app layer.

Add Basic-Auth credentials sourced from `.env` (never literal in the recipe):

```json
{
  "modules": {
    "webui": {
      "host": "0.0.0.0",
      "basicAuth": {
        "username": "${WEBUI_USER}",
        "password": "${WEBUI_PASS}"
      }
    }
  }
}
```

`${VAR}` substitution happens at recipe-load time, so credentials live in
your gitignored `.env` rather than committed to the recipe.

## Caddy

Front Caddy as a system service. The `Caddyfile` for a single recipe:

```caddy
admin.example.internal {
    encode gzip

    # Basic authentication, swap for forward_auth/oauth/etc as needed.
    basic_auth {
        admin $2a$14$...your-bcrypted-password...
    }

    # The WebUI ships static assets and a /ws upgrade. Caddy's reverse_proxy
    # handles WebSocket upgrades transparently — no extra config needed.
    reverse_proxy 127.0.0.1:7340
}
```

If multiple recipes run on one VM, give each a distinct port and a
distinct Caddy block (subdomain or path-based routing both work).

Caddy auto-issues TLS certificates for any public hostname. For
**VPN-only DNS** (where Let's Encrypt can't reach the host), use a
private CA — Caddy supports ACME with internal issuers via the
`tls internal` directive:

```caddy
admin.vpn.internal {
    tls internal
    reverse_proxy 127.0.0.1:7340
    # ...
}
```

## systemd unit

`/etc/systemd/system/connectome-host.service`:

```ini
[Unit]
Description=connectome-host (admin recipe)
After=network.target

[Service]
Type=simple
User=connectome
WorkingDirectory=/opt/connectome-host
Environment=ANTHROPIC_API_KEY=...
EnvironmentFile=/etc/connectome-host/env
ExecStart=/home/connectome/.bun/bin/bun src/index.ts recipes/admin.json --headless
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`--headless` keeps the daemon alive without a TTY. The webui module
serves the admin UI; the headless IPC socket is a separate channel
(intended for parent-process supervision; not used by the WebUI).

## Tailscale-style hostnames

If the VM is on Tailscale, MagicDNS gives you a stable name like
`admin.tailnet-name.ts.net`. Caddy with `tls internal` works there
directly. No DNS or firewall holes needed beyond the existing tailnet.

## Verifying the deployment

After bringing the host up:

```sh
# Health check — should return 200 and HTML.
curl -fsSL https://admin.example.internal/

# WebSocket upgrade — open the URL in a browser. The connection-state
# pill in the header should turn green within a second of page load.
```

The header pill is your primary signal:

- green: connected, traces flowing
- amber: reconnecting
- red: socket unreachable (the SPA shows a banner with elapsed time)

## Debug: context preview

`GET /debug/context` returns the **membrane-normalized request that would be
emitted if the agent were activated right now** — the compiled messages,
system prompt, model config, and filtered tool set. Useful for inspecting
exactly what the model would see.

**Transparent by default.** The endpoint is side-effect-free: it runs no
inference, writes nothing to Chronicle, and contacts no external MCPL server.
It leaves the system state untouched, so you can poll it freely. The cost is
that it omits the *dynamically-gathered* injections (lessons / retrieval /
MCPL context), because gathering those is not transparent.

Query params:

- `agent=<name>` — defaults to the recipe's root agent
- `injections=1` — opt into full fidelity: gather the dynamic injections too.
  **Not transparent** — this can run inference (e.g. the retrieval module's
  Haiku calls cost tokens) and fires MCPL `beforeInference` hooks (whose paired
  `afterInference` is never sent, so a stateful server may be left half-open).
- `pretty=1` — pretty-print the JSON

The response includes `"transparent": true|false` so callers can confirm which
mode ran.

```sh
# Transparent preview (default) — behind the proxy, with the same Basic-Auth
# as the rest of the surface:
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?pretty=1'

# Full-fidelity preview (spends tokens, fires MCPL hooks):
curl -fsSL -u "$WEBUI_USER:$WEBUI_PASS" \
  'https://admin.example.internal/debug/context?injections=1&pretty=1'
```

It is gated by the same Basic-Auth as every other route — note the response
contains the full system prompt and conversation, so treat it as sensitive.

See [`debug-context-api.md`](./debug-context-api.md) for the full reference:
response shape, `jq` recipes, and the transparency contract.

## Multi-VM admin

The module has no built-in cross-VM aggregation. For a fleet of admin
hosts, the simplest pattern is a Caddy block per instance with a
landing page or path prefix:

```caddy
admin.example.internal {
    handle /vm-a/* {
        reverse_proxy 10.0.0.10:7340
    }
    handle /vm-b/* {
        reverse_proxy 10.0.0.11:7340
    }
    # ...
}
```

A future iteration may add a dedicated aggregator service that speaks
the same WS protocol; the module's wire shape is forward-compatible
with that pattern.

## Troubleshooting

- **`refuses to bind ... without auth`**: the default bind is `0.0.0.0`,
  which requires `basicAuth`. Either add credentials, or switch `host` to
  `127.0.0.1` for a loopback-only (local-dev) bind.
- **WebUI bundle not found at .../dist/web**: run `bun install` at the
  package root; the `postinstall` script builds the SPA. For dev, run
  `bun run build:web` from the package root.
- **Disconnect banner stuck**: the host process may have crashed. Check
  `journalctl -u connectome-host -n 100` (or the equivalent for your
  init system). The SPA reconnects automatically once the host is back.
