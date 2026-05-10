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

This server now ships with an HTTP transport (Streamable HTTP per the MCP
spec) and is intended to be exposed on the network behind Caddy with
automatic Let's Encrypt TLS. **No port is published from the Node container
directly** — only Caddy is reachable from the outside.

### Architecture

```
   Internet / LAN                 Docker network "internal"
        │                       ┌────────────┐    ┌────────────┐
        ├── 80, 443 ──────────► │   caddy    │ ─► │  mcp-mail  │
                                │ (TLS, ACME)│    │ Express    │
                                └────────────┘    │ /mcp /healthz
                                                  └────────────┘
```

### Quick start

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env                                          # set MAIL_TOKEN, MCP_PUBLIC_DOMAIN, ACME_EMAIL
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env # generate a strong MCP bearer

# 2. Build and start
docker compose build
docker compose up -d
docker compose logs -f
```

Caddy will obtain a Let's Encrypt certificate automatically on first start
(needs ports 80 and 443 reachable from the Internet for the HTTP-01
challenge). Certificates persist in the `caddy_data` named volume — **do
not** run `docker compose down -v` casually, or you will hit the ACME rate
limits on next startup.

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
