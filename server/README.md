# Esme age-gate captcha verifier

Tiny Express service behind the rotation-puzzle human check in `../index.html`.

| Endpoint | Purpose |
| --- | --- |
| `GET /challenge` | New puzzle: `{id, outer, inner, size, innerSize, expiresInMs}` (WebP data URIs). The correct angle never leaves the server. |
| `POST /verify` | `{id, angle, moves:[[ms,deg],...]}`. One attempt per challenge, 8° tolerance, 2-minute expiry, min solve time 1.5 s, >= 4 distinct slider positions. Success returns a 5-minute HMAC-signed token. |
| `GET /gate` | `Authorization: Bearer <token>` -> `{yesUrl}`. The destination link is only ever delivered after verification. |
| `GET /healthz` | Liveness. |

Per-IP rate limits apply to each endpoint (20/min challenge, 20/min verify, 40/min gate). State is in memory, so run **a single machine** (`fly scale count 1`).

## Config (env)
- `CAPTCHA_SECRET` (required, >=32 chars) - HMAC key. On Fly: `fly secrets set CAPTCHA_SECRET=$(openssl rand -hex 32)`.
- `ALLOWED_ORIGINS` - comma-separated CORS allow-list (default `https://op-era.github.io`).
- `YES_URL` - link returned by `/gate`.

## Local
```
npm ci && npm test
CAPTCHA_SECRET=$(openssl rand -hex 32) ALLOWED_ORIGINS=http://localhost:8000 npm start
# open http://localhost:8000/?api=http://localhost:8080
```

## Deploy
```
fly apps create esme-age-captcha
fly secrets set CAPTCHA_SECRET=$(openssl rand -hex 32) -a esme-age-captcha
fly deploy -a esme-age-captcha   # from this folder
```
