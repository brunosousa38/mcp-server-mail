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

### Usage with Claude Desktop

Add the following to your `claude_desktop_config.json`:

#### NPX

```json
{
  "mcpServers": {
    "mail": {
      "command": "npx",
      "args": [
        "-y",
        "@infomaniak/mcp-server-mail"
      ],
      "env": {
        "MAIL_TOKEN": "your-token"
      }
    }
  }
}
```

#### Docker

```json
{
  "mcpServers": {
    "mail": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "MAIL_TOKEN",
        "infomaniak/mcp-server-mail"
      ],
      "env": {
        "MAIL_TOKEN": "your-token"
      }
    }
  }
}
```

### Environment Variables

1. `MAIL_TOKEN`: Required. Your Infomaniak API token.

### Troubleshooting

If you encounter permission errors, verify that:
1. All required scopes are added to your token
2. The token is correctly copied to your configuration

## Build

Docker build:

```bash
docker build -t infomaniak/mcp-server-mail -f Dockerfile .
```

## License

This MCP server is licensed under the MIT License.
