# Gmail Agent with Telegram 2FA

An email approval gateway that lets AI agents send emails on your behalf — but only after you approve each one via Telegram.

## How it works

1. An AI agent calls the API to send an email
2. You get a Telegram message with the email details and Approve/Decline buttons
3. If you approve, the email is sent from your Gmail account
4. The agent gets notified of the result

## Features

- **Telegram-based approval** — every email requires explicit human approval
- **Multi-user support** — each user has their own Telegram bot and Gmail account
- **Web dashboard** — register users, connect Gmail, view status
- **Thread support** — reply to existing email threads
- **Attachments** — send files via base64-encoded attachments
- **Rate limiting** — configurable request throttling
- **Auto-cleanup** — old resolved requests are purged automatically

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/)
- A [Google Cloud](https://console.cloud.google.com/) project with Gmail API enabled and OAuth 2.0 credentials
- A [Telegram Bot](https://core.telegram.org/bots#how-do-i-create-a-bot) (via @BotFather)

### Local development

```bash
pnpm install
cp .env.example .env
# Fill in all values in .env
pnpm start
```

Open `http://localhost:3000` to access the dashboard.

### Docker

```bash
cp .env.example .env
# Fill in all values in .env
docker compose build
docker compose up -d
```

## Production deployment

The included `docker-compose.yml` uses [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose the app without opening ports or revealing your server IP.

### Setup

1. Add your domain to [Cloudflare](https://dash.cloudflare.com/) (free plan works)
2. Go to [Zero Trust](https://one.dash.cloudflare.com/) > Networks > Tunnels
3. Create a tunnel and copy the token
4. In tunnel config, add a public hostname pointing to `http://gmail-agent:3000`
5. Add `CLOUDFLARE_TUNNEL_TOKEN=<your-token>` to `.env`
6. Update `TELEGRAM_WEBHOOK_URL` and `GMAIL_REDIRECT_URI` to your public domain

```bash
docker compose up -d
```

### Google OAuth setup

1. Create OAuth 2.0 credentials in [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Add your public URL as an authorized redirect URI:
   ```
   https://yourdomain.com/api/auth/callback/google
   ```
3. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REDIRECT_URI` in `.env`

## API

### Send email

```
POST /api/send-email
Header: X-API-Key: <your-api-key>

{
  "userId": "user1",
  "to": ["recipient@example.com"],
  "subject": "Hello",
  "body": "Email body text",
  "cc": ["cc@example.com"],
  "bcc": ["bcc@example.com"],
  "isHtml": false,
  "attachments": [{ "filename": "file.txt", "base64": "...", "contentType": "text/plain" }],
  "threadId": "gmail-thread-id",
  "inReplyTo": "<message-id>",
  "references": ["<msg-id>"]
}
```

Response: `{ "requestId": "uuid", "status": "pending_approval" }`

### Check status

```
GET /api/email-status/:requestId
Header: X-API-Key: <your-api-key>
```

Response: `{ "requestId": "uuid", "status": "pending|approved|declined|sent|failed" }`

## Environment variables

See [`.env.example`](.env.example) for all available configuration options.

## License

[MIT](LICENSE)
