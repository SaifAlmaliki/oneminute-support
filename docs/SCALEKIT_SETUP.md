# Scalekit setup (OneMinute Support)

This app uses Scalekit for **dashboard SSO** (OIDC). The embed widget uses a separate `JWT_SECRET` session — not Scalekit.

## 1. Create a Scalekit application

1. Sign in at [Scalekit](https://app.scalekit.com) and open your environment.
2. Go to **Applications** → create or select your app.
3. Copy:
   - **Environment URL** → `SCALEKIT_ENVIRONMENT_URL`
   - **Client ID** → `SCALEKIT_CLIENT_ID`
   - **Client secret** → `SCALEKIT_CLIENT_SECRET`

## 2. Configure redirect URLs

Under **Redirects**:

| Purpose | URL (local dev) |
|--------|------------------|
| Allowed callback | `http://localhost:3000/api/auth/callback` |
| Post logout | `http://localhost:3000/` |

Set in `.env`:

```env
SCALEKIT_REDIRECT_URI=http://localhost:3000/api/auth/callback
SCALEKIT_POST_LOGOUT_REDIRECT_URI=http://localhost:3000/
```

`SCALEKIT_REDIRECT_URI` must match the callback URL **exactly** (scheme, host, path).

## 3. Webhook (team invitations)

1. **Webhooks** → add endpoint: `https://<your-host>/api/webhook/scalekit`
2. Subscribe to `user.organization_membership_created` (and others as needed).
3. Copy the signing secret → `SCALEKIT_WEBHOOK_SECRET`

For local testing, use a tunnel (e.g. ngrok) and point the webhook at your tunnel URL.

## 4. Local `.env`

```bash
cp .env.example .env
# Fill Scalekit + DATABASE_URL + OPENAI_API_KEY + JWT_SECRET + FIRECRAWL_API_KEY
```

Verify configuration:

```bash
npx tsx scripts/verify-scalekit-env.ts
```

## 5. Auth routes in this repo

| Route | Purpose |
|-------|---------|
| `GET /api/auth` | Start login (redirects to Scalekit) |
| `GET /api/auth/callback` | OAuth callback; sets `user_session` cookie |
| `GET /api/auth/logout` | Clears app cookies; redirects to Scalekit logout |
| `POST /api/webhook/scalekit` | Team membership webhooks |

Protected pages: `/dashboard/**` (middleware checks `user_session`).

## 6. Test the flow

1. `npm run dev`
2. Open `http://localhost:3000` → **Sign in** (or go to `/api/auth`)
3. Complete Scalekit login → you should land on `/dashboard`
4. **Settings** → **Sign out** → should return home with session cleared

## Troubleshooting

- **Invalid redirect_uri**: Callback URL in Scalekit must match `SCALEKIT_REDIRECT_URI`.
- **No organization id in token**: Ensure the user belongs to an organization in Scalekit.
- **CSRF / state error**: Cookies must use `sameSite: lax` (already set). Do not use `strict` for OAuth cookies.
- **Placeholder env**: Run `npx tsx scripts/verify-scalekit-env.ts` and replace `your-env` / `skc_...` values.
