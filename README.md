# Axios JWT Refresh Middleware

Minimalist request middleware for automatic JWT token refresh in Axios.

## Installation

```bash
npm install axios-jwt-refresh-token axios js-cookie
# or
yarn add axios-jwt-refresh-token axios js-cookie
```

## Quick Start

```javascript
import axios from 'axios';
import Cookies from 'js-cookie';
import { createTokenRefreshMiddleware } from 'axios-jwt-refresh-token';

const axiosInstance = axios.create();

const cookieOptions = {
  secure: true,
  sameSite: 'strict'
};

let refreshedTokens = null;

const requestNewTokens = async () => {
  const response = await axios.post('/auth/refresh', {
    refreshToken: Cookies.get('refreshToken')
  });

  refreshedTokens = {
    accessToken: response.data.access_token,
    refreshToken: response.data.refresh_token
  };

  return refreshedTokens;
};

axiosInstance.interceptors.request.use(
  createTokenRefreshMiddleware({
    accessTokenKey: 'accessToken',
    refreshTokenKey: 'refreshToken',
    requestTokens: requestNewTokens,
    setCookiesFunction: () => {
      if (!refreshedTokens) {
        return;
      }

      Cookies.set('accessToken', refreshedTokens.accessToken, cookieOptions);
      Cookies.set('refreshToken', refreshedTokens.refreshToken, cookieOptions);
    },
    onRefreshAndAccessExpire: () => {
      window.location.href = '/login';
    }
  })
);

axiosInstance.get('/api/protected-data')
  .then((response) => console.log(response.data));
```

## Configuration Options

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accessTokenKey` | `string` | Yes | Cookie key used to read the access token |
| `refreshTokenKey` | `string` | Yes | Cookie key used to read the refresh token |
| `requestTokens` | `() => Promise<{ accessToken: string; refreshToken: string }>` | Yes | Function that requests a new token pair |
| `setCookiesFunction` | `() => void` | Yes | Function called after a successful refresh request to save the new tokens |
| `onRefreshAndAccessExpire` | `() => void` | Yes | Callback called when both tokens are missing or refresh fails |
| `timeoutRequest` | `number` | No (`30000`) | Maximum time in milliseconds for requests to wait while another refresh is in progress |

## How It Works

1. Checks the access and refresh tokens in cookies before each request.
2. If an access token exists, adds it to the request as `Authorization: Bearer <token>`.
3. If the access token is missing but the refresh token exists:
   - Locks token refresh so only one refresh request runs at a time.
   - Queues other requests until refresh completes or `timeoutRequest` expires.
   - Calls `requestTokens()`.
   - Calls `setCookiesFunction()` so the application can persist the new tokens.
   - Releases queued requests and attaches the latest access token from cookies.
4. If both tokens are missing, calls `onRefreshAndAccessExpire()` and continues the original request.

## Token Storage

The middleware reads tokens from cookies with `js-cookie`, but token persistence is handled by your application through `setCookiesFunction`.

Use the same keys in `accessTokenKey`, `refreshTokenKey`, and your cookie writes:

```javascript
setCookiesFunction: () => {
  Cookies.set('accessToken', refreshedTokens.accessToken, cookieOptions);
  Cookies.set('refreshToken', refreshedTokens.refreshToken, cookieOptions);
}
```

If your `requestTokens` function already writes tokens to cookies, you can pass a no-op callback:

```javascript
setCookiesFunction: () => {}
```

## Error Handling

### Refresh Token Failure

```javascript
const requestNewTokens = async () => {
  try {
    const response = await axios.post('/auth/refresh');
    return {
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token
    };
  } catch (error) {
    throw error;
  }
};
```

When `requestTokens` fails, the middleware calls `onRefreshAndAccessExpire`.

### Response Interceptor

```javascript
axiosInstance.interceptors.response.use(null, (error) => {
  if (error.response?.status === 401) {
    // Handle unauthorized errors
  }

  return Promise.reject(error);
});
```

## Limitations

- Browser environment only because the middleware uses `js-cookie`.
- The middleware does not persist tokens by itself; use `setCookiesFunction`.
- No built-in retry mechanism for failed refresh attempts.
- No built-in response interceptor for handling 401 responses.

## Best Practices

1. Always implement `onRefreshAndAccessExpire` to handle expired sessions.
2. Keep `accessTokenKey` and `refreshTokenKey` in sync with the cookies you write.
3. Use secure cookie options in production.
4. Add error handling to your `requestTokens` function.
5. Consider adding response-level handling for unauthorized requests.
