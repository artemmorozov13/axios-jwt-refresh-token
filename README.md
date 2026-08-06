# jwt-token-refresh-middleware

Automatic JWT refresh middleware for Axios with TypeScript support.

It adds access tokens to outgoing requests, refreshes expired tokens, keeps concurrent requests behind one refresh call, and can retry the original request after a `401`.

## Installation

```bash
npm install jwt-token-refresh-middleware axios
```

Install `js-cookie` only if you want cookie-based storage helpers:

```bash
npm install js-cookie
```

## Recommended Usage

Use `applyTokenRefreshMiddleware` when you want both behaviors:

- refresh before a request when the access token is missing or expired by JWT `exp`;
- refresh and retry once when the server returns `401`.

```ts
import axios from 'axios'
import { applyTokenRefreshMiddleware } from 'jwt-token-refresh-middleware'

const apiClient = axios.create({ baseURL: '/api' })
const authClient = axios.create({ baseURL: '/api' })

let accessToken: string | undefined
let refreshToken: string | undefined

applyTokenRefreshMiddleware(apiClient, {
  getAccessToken: () => accessToken,
  getRefreshToken: () => refreshToken,
  requestTokens: async () => {
    const response = await authClient.post('/auth/refresh', {
      refreshToken
    })

    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token
    }
  },
  setTokens: (tokens) => {
    accessToken = tokens.accessToken
    refreshToken = tokens.refreshToken
  },
  onRefreshAndAccessExpire: () => {
    window.location.href = '/login'
  }
})
```

Use a separate Axios instance for `requestTokens`, or skip the refresh endpoint with `shouldSkip`, so the refresh request does not intercept itself.

## Cookie Storage

Cookie storage is available as a separate helper. This keeps the core package usable without a hard runtime dependency on `js-cookie`.

```ts
import { applyTokenRefreshMiddleware } from 'jwt-token-refresh-middleware'
import { createCookieTokenStorage } from 'jwt-token-refresh-middleware/cookie-storage'

applyTokenRefreshMiddleware(apiClient, {
  ...createCookieTokenStorage({
    accessTokenKey: 'accessToken',
    refreshTokenKey: 'refreshToken',
    accessTokenCookieOptions: {
      secure: true,
      sameSite: 'strict'
    },
    refreshTokenCookieOptions: {
      secure: true,
      sameSite: 'strict'
    }
  }),
  requestTokens,
  onRefreshAndAccessExpire: logout
})
```

For backward compatibility, `accessTokenKey`, `refreshTokenKey`, and `setCookiesFunction` still work when `js-cookie` is installed.

## Manual Interceptors

If you want to register interceptors yourself and still share one queue between them:

```ts
import { createTokenRefreshInterceptors } from 'jwt-token-refresh-middleware'

const tokenRefresh = createTokenRefreshInterceptors(options)

apiClient.interceptors.request.use(tokenRefresh.request)
apiClient.interceptors.response.use(undefined, tokenRefresh.responseError(apiClient))
```

Request-only usage is still supported:

```ts
import { createTokenRefreshMiddleware } from 'jwt-token-refresh-middleware'

apiClient.interceptors.request.use(createTokenRefreshMiddleware(options))
```

Response-only usage is also available:

```ts
import { createTokenRefreshResponseInterceptor } from 'jwt-token-refresh-middleware'

apiClient.interceptors.response.use(
  undefined,
  createTokenRefreshResponseInterceptor(apiClient, options)
)
```

## Behavior

1. Adds `Authorization: Bearer <accessToken>` when the access token is present and not expired.
2. Refreshes tokens when the access token is missing, its JWT `exp` value has expired, or it looks
   like a JWT but can't be decoded/parsed (fails safe - a token whose claims can't be verified is
   treated as expired instead of being sent as-is). Non-JWT (opaque) tokens are left to the `401`
   flow below.
3. Retries the original failed request once when the response status is `401`.
4. Runs only one refresh request at a time per interceptor set.
5. Queues concurrent request and response flows until refresh succeeds, fails, or times out.
6. Rejects requests when refresh is impossible or fails, after calling `onRefreshAndAccessExpire`.

## API

### Required Options

| Option | Type | Description |
| --- | --- | --- |
| `requestTokens` | `() => Promise<{ accessToken: string; refreshToken?: string }>` | Requests a fresh access token. `refreshToken` is optional - omit it if your backend doesn't rotate refresh tokens. |
| `onRefreshAndAccessExpire` | `(error?: unknown) => void \| Promise<void>` | Called when the session cannot be refreshed. |

### Storage Options

Use custom storage for production-sensitive apps:

| Option | Type | Description |
| --- | --- | --- |
| `getAccessToken` | `() => string \| undefined \| Promise<string \| undefined>` | Reads the current access token. |
| `getRefreshToken` | `() => string \| undefined \| Promise<string \| undefined>` | Reads the current refresh token. |
| `setTokens` | `(tokens) => void \| Promise<void>` | Persists refreshed tokens. |

Cookie-compatible options:

| Option | Type | Description |
| --- | --- | --- |
| `accessTokenKey` | `string` | Cookie key used by the built-in `js-cookie` fallback. |
| `refreshTokenKey` | `string` | Cookie key used by the built-in `js-cookie` fallback. |
| `setCookiesFunction` | `(tokens) => void \| Promise<void>` | Backward-compatible alias for `setTokens`. |

### Behavior Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `timeoutRequest` | `number` | `30000` | Maximum time in milliseconds for refresh and queued requests. |
| `refreshBeforeExpirationMs` | `number` | `0` | Refreshes JWT access tokens this many milliseconds before `exp`. |
| `statusCodes` | `number[]` | `[401]` | Response statuses that trigger refresh and retry. |
| `shouldRefreshAccessToken` | `(accessToken, config) => boolean \| Promise<boolean>` | missing or expired JWT | Custom request refresh decision. |
| `shouldRetryResponse` | `(error) => boolean \| Promise<boolean>` | status in `statusCodes` | Custom response retry decision. |
| `shouldSkip` | `(config) => boolean` | `undefined` | Skips request refresh and response retry for selected requests. |
| `authorizationHeaderName` | `string` | `Authorization` | Header name for the access token. |
| `authorizationHeaderPrefix` | `string` | `Bearer` | Header prefix. Use an empty string to send the raw token. |
| `crossTabLock` | `boolean` | `false` | Coordinates refresh across browser tabs sharing the same token storage. See [Cross-Tab Coordination](#cross-tab-coordination). |
| `crossTabLockKey` | `string` | `accessTokenKey` or `refreshTokenKey` | Storage key used for the cross-tab lock. Set it explicitly if you run multiple independent `applyTokenRefreshMiddleware` instances in the same app. |

## Cross-Tab Coordination

Each `createTokenRefreshInterceptors` (or `applyTokenRefreshMiddleware`) call already guarantees a
single in-flight `requestTokens()` call *within one tab*. It knows nothing about other tabs by
default, though - if your token storage is shared across tabs (cookies, or a custom storage backed
by `localStorage`), two tabs can each decide the access token is expired and call `requestTokens()`
at the same moment. If your backend rotates refresh tokens (single-use), the loser of that race can
end up logged out.

Set `crossTabLock: true` to reduce this: tabs coordinate through a `localStorage` entry so that only
one tab calls `requestTokens()` at a time; the others wait for it to finish and then re-read the
tokens it stored.

```ts
applyTokenRefreshMiddleware(apiClient, {
  ...createCookieTokenStorage({ accessTokenKey: 'accessToken', refreshTokenKey: 'refreshToken' }),
  requestTokens,
  onRefreshAndAccessExpire: logout,
  crossTabLock: true
})
```

This is **best-effort, not a hard mutex**:

- It only helps when tabs actually share token storage. With purely in-memory, per-tab tokens there
  is nothing to coordinate and each tab still refreshes independently.
- A waiting tab gives up and refreshes on its own if the lock holder doesn't finish in time, so it
  never waits past its own `timeoutRequest`.
- It's disabled by default and does nothing outside a browser (no `localStorage` -> no-op), so it's
  safe to enable even in code that also runs during SSR.
- If you run several independent `applyTokenRefreshMiddleware`/`createTokenRefreshInterceptors`
  instances in the same app (e.g. one per API), pass a distinct `crossTabLockKey` for each so they
  don't coordinate with each other by accident.

## Security Notes

The package no longer requires cookie storage for core usage. Prefer a storage strategy that matches your app's threat model. JavaScript-readable cookies, localStorage, and in-memory storage all have different tradeoffs around XSS, CSRF, refresh persistence, and multi-tab behavior.

## Package Formats

The package ships CommonJS, ESM, and TypeScript declarations:

- CommonJS: `dist/index.js`
- ESM: `dist/index.mjs`
- Types: `dist/index.d.ts`

## License

MIT
