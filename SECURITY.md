# Security

Each copy of Pacedex runs on its owner's own Cloudflare and GitHub accounts. There's no shared server, so a problem in one copy can't reach another. The code itself can still have bugs, though, and those affect everyone who runs it.

## The keys

`npm run setup` makes these keys and keeps them in `.secrets.local`, which is gitignored. It also saves each one as a Worker secret.

| Key | Held by | What it can do |
| --- | --- | --- |
| `APP_KEY` | the Home Screen app | read usage, connect and disconnect services, manage notifications |
| `WIDGET_KEY` | the Scriptable widget, in the iOS Keychain | `GET /api/usage` only |
| `RELAY_KEY` | your repo's Actions secrets | the relay's two routes only |
| `ENC_KEY` | the Worker only | encrypts the stored sign-in tokens (AES-GCM) |
| `VAPID_PRIVATE_JWK` | the Worker only | signs Web Push messages to your phone |
| `GH_TOKEN` (optional) | the Worker only | starts the Codex relay in your one repo; create it with only **Actions: read and write** |

Requests without a valid key get a 401. Keys are compared in constant time.

## If a key leaks

Delete `.secrets.local` and run `npm run setup` again. That makes all-new keys, saves them on the Worker and in GitHub, and prints a new sign-in link for your phone. Every old key stops working at once. After that:

- Open the new link and add the app to your Home Screen again.
- Reconnect the widget from settings.
- Turn notifications on again.
- Sign in to Claude and Codex again, since the new `ENC_KEY` can't read the old tokens.

If you think a sign-in token itself leaked, also revoke the app's access from your Claude or ChatGPT account settings.

## Reporting a problem

Please report vulnerabilities privately, through **Security → Report a vulnerability** on this repository, rather than in a public issue. Include what you found and how to reproduce it. I'll reply as soon as I can.
