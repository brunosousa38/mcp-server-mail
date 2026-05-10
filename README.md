# Mail MCP Server

MCP Server for the Infomaniak Mail API.

## Tools

1. `mail_list_mailboxes`
   - List all mailboxes in your Infomaniak account
   - Returns: List of mailboxes with uuid, email, and mailbox name

2. `mail_list_folders`
   - List all folders in a mailbox
   - Required inputs:
     - `mailbox_uuid` (string, optional): Mailbox UUID (uses primary if omitted)
   - Returns: List of folders with id, name, path, role, unread/total counts

3. `mail_list_emails`
   - List emails in a folder
   - Required inputs:
     - `folder_id` (string): Folder ID
   - Optional inputs:
     - `mailbox_uuid` (string): Mailbox UUID
     - `limit` (number): Maximum emails to return (default: 50)
     - `offset` (number): Pagination offset (default: 0)
   - Returns: List of email threads with subject, from, date, preview

4. `mail_read_email`
   - Read a specific email
   - Required inputs:
     - `folder_id` (string): Folder ID containing the email
     - `message_id` (string): Message ID or UID
   - Optional inputs:
     - `mailbox_uuid` (string): Mailbox UUID
   - Returns: Full email with subject, from, to, body, html, headers

5. `mail_send_email`
   - Send an email
   - Required inputs:
     - `to` (string): Recipient email address(es), comma-separated
     - `subject` (string): Email subject
     - `body` (string): Email body (plain text)
   - Optional inputs:
     - `cc` (string): CC recipient(s), comma-separated
     - `bcc` (string): BCC recipient(s), comma-separated
   - Returns: Send confirmation with timestamp

## Setup

1. Create a token linked to your user:
    - Visit the [API Token page](https://manager.infomaniak.com/v3/ng/accounts/token/list)
    - Choose "workspace:mail" scopes

## Networked deployment (Docker Compose + Caddy)

This server ships with a Streamable HTTP MCP transport and three deployment
modes managed via a **Makefile**. Pick the one that matches your network:

| Mode | TLS | Domain needed | Internet needed | Command |
|---|---|---|---|---|
| **WAN** | ✅ Let's Encrypt | ✅ public domain | ✅ ports 80+443 | `make up-wan` |
| **LAN TLS** | ✅ self-signed (Caddy local CA) | ❌ | ❌ | `make up-lan` |
| **LAN HTTP** | ❌ plain HTTP | ❌ | ❌ | `make up-lan-http` |

In all modes the Node container **never publishes a port directly** except
in LAN HTTP mode. Caddy acts as the sole ingress.

### Quick start (any mode)

```bash
# 1. First-time setup — copies .env.example and generates MCP_AUTH_TOKEN
make setup-env

# 2. Fill in the required secrets
$EDITOR .env    # MAIL_TOKEN is always required; choose mode-specific vars below

# 3. Start
make up-wan         # or: make up-lan   or: make up-lan-http
```

Run `make help` to see all available targets.

### WAN mode

Requires `MCP_PUBLIC_DOMAIN` (e.g. `mcp.example.com`) and `ACME_EMAIL` in `.env`.
Ports **80 and 443** must be reachable from the Internet for the ACME HTTP-01
challenge. Certificates persist in the `caddy_data` named volume — **do
not** run `docker compose down -v`, or you will hit Let's Encrypt rate limits
on next startup.

```
   Internet                    Docker network "internal"
        │                    ┌────────────────┐    ┌───────────────┐
        ├── 80,443 ─────────►│  caddy (WAN)   │───►│  mcp-mail     │
                             │  Let's Encrypt │    │  Express :3000│
                             └────────────────┘    └───────────────┘
```

### LAN TLS mode

No domain, no Internet. Caddy generates its own local CA and self-signed cert.
Clients will see a TLS warning until you trust the Caddy CA:

```bash
make up-lan
docker compose exec caddy caddy trust   # installs CA on the host machine
```

Set `MCP_LAN_HOST` in `.env` to control the bind address:
- `:443` — all interfaces, port 443 (default)
- `mcp.local` — local hostname (must resolve to the server IP)
- `192.168.1.10:443` — specific LAN IP

```
   LAN                        Docker network "internal"
        │                    ┌──────────────────┐    ┌───────────────┐
        ├── 443 ────────────►│  caddy (LAN-TLS) │───►│  mcp-mail     │
                             │  tls internal    │    │  Express :3000│
                             └──────────────────┘    └───────────────┘
```

### LAN HTTP mode

Simplest option — no reverse proxy, no TLS. Port `LAN_HTTP_PORT` (default 3000)
is published directly from the container. The MCP bearer token still enforces
authentication.

```
   LAN                        Docker
        │                    ┌───────────────┐
        ├── :3000 ──────────►│  mcp-mail     │
                             │  Express :3000│
                             └───────────────┘
```

### Endpoints

| Endpoint        | Auth   | Purpose                                                |
|-----------------|--------|--------------------------------------------------------|
| `GET  /healthz` | none   | Liveness probe used by Caddy and Docker healthcheck     |
| `POST /mcp`     | Bearer | Client → server JSON-RPC. New session on `initialize`. |
| `GET  /mcp`     | Bearer | Long-lived SSE stream for server → client notifications |
| `DELETE /mcp`   | Bearer | Explicit session termination                           |

All `/mcp*` requests must include `Authorization: Bearer $MCP_AUTH_TOKEN`.
Sessions are tracked via the `mcp-session-id` response/request header.

### Connecting clients

#### MCP Inspector

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP
# URL: https://mcp.example.com/mcp
# Header: Authorization=Bearer <MCP_AUTH_TOKEN>
```

#### Claude Desktop (via mcp-remote bridge)

Claude Desktop currently speaks stdio only, so use `mcp-remote` as a
local-to-HTTP bridge:

```json
{
  "mcpServers": {
    "mail": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://mcp.example.com/mcp",
        "--header",
        "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"
      ]
    }
  }
}
```

#### Manual smoke test

```bash
TOKEN=...   # MCP_AUTH_TOKEN

# 1. Health (no auth)
curl -fsS https://mcp.example.com/healthz

# 2. Auth required
curl -i -X POST https://mcp.example.com/mcp        # → 401

# 3. Initialize and capture mcp-session-id
curl -i -X POST https://mcp.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-03-26","capabilities":{},
       "clientInfo":{"name":"curl","version":"0"}}}'
```

### Environment variables

| Variable                       | Default     | Required | Purpose                                    |
|--------------------------------|-------------|----------|--------------------------------------------|
| `MAIL_TOKEN`                   | —           | yes      | Infomaniak Mail API bearer                 |
| `MCP_AUTH_TOKEN`               | —           | yes ≥32  | Bearer enforced on `/mcp*`                 |
| `MCP_HTTP_PORT`                | `3000`      | no       | Internal Express port                      |
| `MCP_HTTP_HOST`                | `0.0.0.0`   | no       | Bind address inside container              |
| `MCP_ALLOWED_ORIGINS`          | (empty)     | no       | CSV CORS allowlist (`*` rejected in prod)  |
| `MCP_RATE_LIMIT_PER_MIN`       | `60`        | no       | Per-IP req/min on `/mcp`                   |
| `MCP_SEND_RATE_LIMIT_PER_MIN`  | `5`         | no       | Strict cap on `mail_send_email`            |
| `MCP_TRUST_PROXY`              | `1`         | no       | `app.set('trust proxy', N)` (1 = Caddy)    |
| `LOG_LEVEL`                    | `info`      | no       | pino log level                             |
| `MCP_PUBLIC_DOMAIN`            | —           | yes      | Public hostname served by Caddy            |
| `ACME_EMAIL`                   | —           | yes      | Contact for Let's Encrypt                  |

### Security notes

- `MCP_AUTH_TOKEN` grants the same access as `MAIL_TOKEN` — anyone holding
  it can read and send mail from the configured Infomaniak mailbox. Treat
  both as production secrets and rotate regularly.
- The `mail_send_email` tool is rate-limited and audit-logged
  (recipient/subject hashes only, no PII).
- Container runs as non-root user `mcp` with `tini` as PID 1 for clean
  signal handling.
- TLS is terminated by Caddy with HSTS preload, X-Frame-Options DENY,
  Referrer-Policy no-referrer, and modern protocols only.
- For LAN-only deployments, restrict access at the firewall or add an
  IP allowlist in the Caddyfile (`@allowed remote_ip ...`).

## Local development (stdio is no longer the default)

The server now requires HTTP. To run locally without Docker:

```bash
npm install
npm run build
MAIL_TOKEN=... MCP_AUTH_TOKEN=$(openssl rand -hex 32) \
  MCP_HTTP_HOST=127.0.0.1 npm start
```

Then point `@modelcontextprotocol/inspector` at `http://127.0.0.1:3000/mcp`.

## Build

Docker build:

```bash
docker compose build
```

## License

This MCP server is licensed under the MIT License.
