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

The defaults are `127.0.0.1:7340`. The module **refuses to start** if
`host` is non-loopback and no auth is configured, unless you set
`acknowledgeNoAuth: true` to confirm you've fronted it with a proxy.

For a single-VM admin scenario fronted by a reverse proxy, keep the
module bound to `127.0.0.1` and let Caddy/nginx terminate TLS. Public
exposure is the proxy's job.

If you want to skip the reverse proxy and let the module itself handle
client auth (defense in depth, or a temporary local-network demo), add
Basic-Auth credentials sourced from `.env`:

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

- **`refuses to bind ... without auth`**: set `basicAuth`, switch
  `host` to `127.0.0.1`, or set `acknowledgeNoAuth: true`.
- **WebUI bundle not found at .../dist/web**: run `bun install` at the
  package root; the `postinstall` script builds the SPA. For dev, run
  `bun run build:web` from the package root.
- **Disconnect banner stuck**: the host process may have crashed. Check
  `journalctl -u connectome-host -n 100` (or the equivalent for your
  init system). The SPA reconnects automatically once the host is back.
