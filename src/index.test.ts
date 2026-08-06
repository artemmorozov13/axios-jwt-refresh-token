import { AxiosError, AxiosHeaders, AxiosInstance, InternalAxiosRequestConfig } from 'axios'
import Cookies from 'js-cookie'
import {
  AuthTokensMissingError,
  TokenRefreshError,
  TokenRefreshTimeoutError,
  applyTokenRefreshMiddleware,
  createTokenRefreshInterceptors,
  createTokenRefreshMiddleware,
  createTokenRefreshResponseInterceptor
} from './index'

jest.mock('js-cookie', () => ({
  __esModule: true,
  default: {
    get: jest.fn()
  }
}))

const getCookieMock = Cookies.get as unknown as jest.Mock<string | undefined, [string]>

const createConfig = (url = '/users'): InternalAxiosRequestConfig => ({
  url,
  headers: new AxiosHeaders()
} as InternalAxiosRequestConfig)

const createAxiosError = (status: number, config = createConfig()): AxiosError => ({
  isAxiosError: true,
  name: 'AxiosError',
  message: 'Request failed',
  config,
  toJSON: () => ({}),
  response: {
    status,
    statusText: 'Unauthorized',
    headers: {},
    config,
    data: {}
  }
} as AxiosError)

const createAxiosInstance = () => ({
  request: jest.fn(),
  interceptors: {
    request: {
      use: jest.fn(() => 1),
      eject: jest.fn()
    },
    response: {
      use: jest.fn(() => 2),
      eject: jest.fn()
    }
  }
} as unknown as AxiosInstance & { request: jest.Mock })

const createJwt = (exp: number) => {
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url')
  return `header.${payload}.signature`
}

// Valid base64url, but the decoded payload isn't JSON - simulates a corrupted/tampered JWT.
const createMalformedJwt = () => {
  const payload = Buffer.from('not-json-payload').toString('base64url')
  return `header.${payload}.signature`
}

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()

  return {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

describe('createTokenRefreshMiddleware', () => {
  const now = 1_700_000_000_000
  let cookies: Record<string, string | undefined>

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now)

    cookies = {}
    getCookieMock.mockImplementation((key) => cookies[key])
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('adds the current access token without refreshing', async () => {
    cookies.accessToken = 'access-token'
    cookies.refreshToken = 'refresh-token'

    const requestTokens = jest.fn()
    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens,
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(config.headers.get('Authorization')).toBe('Bearer access-token')
    expect(requestTokens).not.toHaveBeenCalled()
  })

  it('refreshes when the access token is missing and stores returned tokens', async () => {
    cookies.refreshToken = 'refresh-token'

    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens: jest.fn().mockResolvedValue({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token'
      }),
      setTokens: jest.fn((tokens) => {
        cookies.accessToken = tokens.accessToken
        cookies.refreshToken = tokens.refreshToken
      }),
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(config.headers.get('Authorization')).toBe('Bearer new-access-token')
    expect(cookies.refreshToken).toBe('new-refresh-token')
  })

  it('keeps backward compatibility with setCookiesFunction', async () => {
    cookies.refreshToken = 'refresh-token'

    const setCookiesFunction = jest.fn((tokens) => {
      cookies.accessToken = tokens.accessToken
      cookies.refreshToken = tokens.refreshToken
    })

    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens: jest.fn().mockResolvedValue({
        accessToken: 'compat-access-token',
        refreshToken: 'compat-refresh-token'
      }),
      setCookiesFunction,
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(setCookiesFunction).toHaveBeenCalledWith({
      accessToken: 'compat-access-token',
      refreshToken: 'compat-refresh-token'
    })
    expect(config.headers.get('Authorization')).toBe('Bearer compat-access-token')
  })

  it('queues concurrent requests while a refresh is in progress', async () => {
    let resolveRefresh: ((tokens: { accessToken: string; refreshToken: string }) => void) | undefined
    let accessToken: string | undefined
    const requestTokens = jest.fn(
      () =>
        new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
          resolveRefresh = resolve
        })
    )

    const middleware = createTokenRefreshMiddleware({
      getAccessToken: () => accessToken,
      getRefreshToken: () => 'refresh-token',
      requestTokens,
      setTokens: (tokens) => {
        accessToken = tokens.accessToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const firstRequest = middleware(createConfig())
    const secondRequest = middleware(createConfig())
    const thirdRequest = middleware(createConfig())

    await flushPromises()

    expect(requestTokens).toHaveBeenCalledTimes(1)

    if (!resolveRefresh) {
      throw new Error('Refresh resolver was not initialized')
    }

    resolveRefresh({
      accessToken: 'queued-access-token',
      refreshToken: 'queued-refresh-token'
    })

    const configs = await Promise.all([firstRequest, secondRequest, thirdRequest])

    expect(configs.map((config) => config.headers.get('Authorization'))).toEqual([
      'Bearer queued-access-token',
      'Bearer queued-access-token',
      'Bearer queued-access-token'
    ])
  })

  it('rejects queued requests immediately when refresh fails', async () => {
    let rejectRefresh: ((error: Error) => void) | undefined
    const onRefreshAndAccessExpire = jest.fn()
    const requestTokens = jest.fn(
      () =>
        new Promise<{ accessToken: string; refreshToken: string }>((_, reject) => {
          rejectRefresh = reject
        })
    )

    const middleware = createTokenRefreshMiddleware({
      getAccessToken: () => undefined,
      getRefreshToken: () => 'refresh-token',
      requestTokens,
      onRefreshAndAccessExpire
    })

    const firstRequest = middleware(createConfig())
    const secondRequest = middleware(createConfig())

    await flushPromises()

    if (!rejectRefresh) {
      throw new Error('Refresh rejecter was not initialized')
    }

    rejectRefresh(new Error('refresh failed'))

    const results = await Promise.allSettled([firstRequest, secondRequest])

    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('rejected')
    expect(onRefreshAndAccessExpire).toHaveBeenCalledTimes(2)
    expect(results[0]).toMatchObject({ reason: expect.any(TokenRefreshError) })
    expect(results[1]).toMatchObject({ reason: expect.any(TokenRefreshError) })
  })

  it('refreshes an expired JWT even if it is still present in cookies', async () => {
    cookies.accessToken = createJwt(Math.floor(now / 1000) - 60)
    cookies.refreshToken = 'refresh-token'

    const requestTokens = jest.fn().mockResolvedValue({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token'
    })

    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens,
      setTokens: (tokens) => {
        cookies.accessToken = tokens.accessToken
        cookies.refreshToken = tokens.refreshToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(requestTokens).toHaveBeenCalledTimes(1)
    expect(config.headers.get('Authorization')).toBe('Bearer fresh-access-token')
  })

  it('refreshes when the access token looks like a JWT but its claims cannot be parsed', async () => {
    cookies.accessToken = createMalformedJwt()
    cookies.refreshToken = 'refresh-token'

    const requestTokens = jest.fn().mockResolvedValue({
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token'
    })

    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens,
      setTokens: (tokens) => {
        cookies.accessToken = tokens.accessToken
        cookies.refreshToken = tokens.refreshToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(requestTokens).toHaveBeenCalledTimes(1)
    expect(config.headers.get('Authorization')).toBe('Bearer fresh-access-token')
  })

  it('does not refresh a non-JWT (opaque) access token', async () => {
    cookies.accessToken = 'opaque-session-token'
    cookies.refreshToken = 'refresh-token'

    const requestTokens = jest.fn()
    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens,
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(requestTokens).not.toHaveBeenCalled()
    expect(config.headers.get('Authorization')).toBe('Bearer opaque-session-token')
  })

  it('accepts a refreshed token pair without a rotated refreshToken', async () => {
    cookies.refreshToken = 'refresh-token'

    const setTokens = jest.fn((tokens: { accessToken: string; refreshToken?: string }) => {
      cookies.accessToken = tokens.accessToken
    })

    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens: jest.fn().mockResolvedValue({ accessToken: 'non-rotated-access-token' }),
      setTokens,
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(setTokens).toHaveBeenCalledWith({ accessToken: 'non-rotated-access-token' })
    expect(config.headers.get('Authorization')).toBe('Bearer non-rotated-access-token')
  })

  it('rejects when both access and refresh tokens are missing', async () => {
    const onRefreshAndAccessExpire = jest.fn()
    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens: jest.fn(),
      onRefreshAndAccessExpire
    })

    await expect(middleware(createConfig())).rejects.toBeInstanceOf(AuthTokensMissingError)
    expect(onRefreshAndAccessExpire).toHaveBeenCalledTimes(1)
  })

  it('times out refresh requests and releases the queue', async () => {
    jest.useFakeTimers()

    const onRefreshAndAccessExpire = jest.fn()
    const middleware = createTokenRefreshMiddleware({
      getAccessToken: () => undefined,
      getRefreshToken: () => 'refresh-token',
      timeoutRequest: 100,
      requestTokens: jest.fn(() => new Promise(() => undefined)),
      onRefreshAndAccessExpire
    })

    const firstRequest = middleware(createConfig())
    const secondRequest = middleware(createConfig())
    const firstExpectation = expect(firstRequest).rejects.toBeInstanceOf(TokenRefreshTimeoutError)
    const secondExpectation = expect(secondRequest).rejects.toBeInstanceOf(TokenRefreshTimeoutError)

    await flushPromises()
    await jest.advanceTimersByTimeAsync(100)

    await firstExpectation
    await secondExpectation
    expect(onRefreshAndAccessExpire).toHaveBeenCalledTimes(2)
  })

  it('skips selected requests', async () => {
    const requestTokens = jest.fn()
    const middleware = createTokenRefreshMiddleware({
      accessTokenKey: 'accessToken',
      refreshTokenKey: 'refreshToken',
      requestTokens,
      onRefreshAndAccessExpire: jest.fn(),
      shouldSkip: (config) => config.url === '/auth/refresh'
    })

    const config = await middleware(createConfig('/auth/refresh'))

    expect(config.headers.get('Authorization')).toBeUndefined()
    expect(requestTokens).not.toHaveBeenCalled()
  })

  it('supports custom storage callbacks without cookie storage', async () => {
    let accessToken: string | undefined
    let refreshToken: string | undefined = 'custom-refresh-token'

    const middleware = createTokenRefreshMiddleware({
      getAccessToken: () => accessToken,
      getRefreshToken: () => refreshToken,
      requestTokens: jest.fn().mockResolvedValue({
        accessToken: 'custom-access-token',
        refreshToken: 'custom-refresh-token-2'
      }),
      setTokens: (tokens) => {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = await middleware(createConfig())

    expect(config.headers.get('Authorization')).toBe('Bearer custom-access-token')
    expect(refreshToken).toBe('custom-refresh-token-2')
    expect(getCookieMock).not.toHaveBeenCalled()
  })

  it('supports custom authorization headers', async () => {
    const middleware = createTokenRefreshMiddleware({
      getAccessToken: () => 'api-token',
      getRefreshToken: () => 'refresh-token',
      requestTokens: jest.fn(),
      onRefreshAndAccessExpire: jest.fn(),
      authorizationHeaderName: 'X-API-Token',
      authorizationHeaderPrefix: ''
    })

    const config = await middleware(createConfig())

    expect(config.headers.get('X-API-Token')).toBe('api-token')
  })

  it('keeps queues isolated between middleware instances', async () => {
    let firstAccessToken: string | undefined
    let secondAccessToken: string | undefined

    let resolveFirstRefresh: ((tokens: { accessToken: string; refreshToken: string }) => void) | undefined
    const firstRequestTokens = jest.fn(
      () =>
        new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
          resolveFirstRefresh = resolve
        })
    )
    const secondRequestTokens = jest.fn().mockResolvedValue({
      accessToken: 'second-access-token',
      refreshToken: 'second-refresh-token'
    })

    const firstMiddleware = createTokenRefreshMiddleware({
      getAccessToken: () => firstAccessToken,
      getRefreshToken: () => 'first-refresh-token',
      requestTokens: firstRequestTokens,
      setTokens: (tokens) => {
        firstAccessToken = tokens.accessToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })
    const secondMiddleware = createTokenRefreshMiddleware({
      getAccessToken: () => secondAccessToken,
      getRefreshToken: () => 'second-refresh-token',
      requestTokens: secondRequestTokens,
      setTokens: (tokens) => {
        secondAccessToken = tokens.accessToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const firstRequest = firstMiddleware(createConfig())
    const secondConfig = await secondMiddleware(createConfig())

    expect(firstRequestTokens).toHaveBeenCalledTimes(1)
    expect(secondRequestTokens).toHaveBeenCalledTimes(1)
    expect(secondConfig.headers.get('Authorization')).toBe('Bearer second-access-token')

    if (!resolveFirstRefresh) {
      throw new Error('First refresh resolver was not initialized')
    }

    resolveFirstRefresh({
      accessToken: 'first-access-token',
      refreshToken: 'first-refresh-token-2'
    })

    const firstConfig = await firstRequest

    expect(firstConfig.headers.get('Authorization')).toBe('Bearer first-access-token')
  })
})

describe('response refresh interceptor', () => {
  it('refreshes tokens and retries the original request after 401', async () => {
    let accessToken = 'stale-access-token'
    let refreshToken: string | undefined = 'refresh-token'
    const retriedResponse = { data: { ok: true } }
    const axiosInstance = createAxiosInstance()
    axiosInstance.request.mockResolvedValue(retriedResponse)

    const responseInterceptor = createTokenRefreshResponseInterceptor(axiosInstance, {
      getAccessToken: () => accessToken,
      getRefreshToken: () => refreshToken,
      requestTokens: jest.fn().mockResolvedValue({
        accessToken: 'retried-access-token',
        refreshToken: 'retried-refresh-token'
      }),
      setTokens: (tokens) => {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const config = createConfig('/private')
    const response = await responseInterceptor(createAxiosError(401, config))

    expect(response).toBe(retriedResponse)
    expect(axiosInstance.request).toHaveBeenCalledWith(expect.objectContaining({
      url: '/private',
      _jwtRefreshRetry: true
    }))
    expect(config.headers.get('Authorization')).toBe('Bearer retried-access-token')
  })

  it('does not retry the same response twice', async () => {
    const axiosInstance = createAxiosInstance()
    const config = createConfig('/private')
    Object.assign(config, { _jwtRefreshRetry: true })
    const error = createAxiosError(401, config)

    const responseInterceptor = createTokenRefreshResponseInterceptor(axiosInstance, {
      getAccessToken: () => 'access-token',
      getRefreshToken: () => 'refresh-token',
      requestTokens: jest.fn(),
      onRefreshAndAccessExpire: jest.fn()
    })

    await expect(responseInterceptor(error)).rejects.toBe(error)
    expect(axiosInstance.request).not.toHaveBeenCalled()
  })

  it('shares the queue between request and response interceptors from one factory call', async () => {
    let accessToken: string | undefined
    let resolveRefresh: ((tokens: { accessToken: string; refreshToken: string }) => void) | undefined
    const axiosInstance = createAxiosInstance()
    axiosInstance.request.mockResolvedValue({ data: { ok: true } })

    const interceptors = createTokenRefreshInterceptors({
      getAccessToken: () => accessToken,
      getRefreshToken: () => 'refresh-token',
      requestTokens: jest.fn(
        () =>
          new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
            resolveRefresh = resolve
          })
      ),
      setTokens: (tokens) => {
        accessToken = tokens.accessToken
      },
      onRefreshAndAccessExpire: jest.fn()
    })

    const request = interceptors.request(createConfig('/before-request'))
    const response = interceptors.responseError(axiosInstance)(createAxiosError(401, createConfig('/after-401')))

    await flushPromises()

    if (!resolveRefresh) {
      throw new Error('Refresh resolver was not initialized')
    }

    resolveRefresh({
      accessToken: 'shared-access-token',
      refreshToken: 'shared-refresh-token'
    })

    const [requestConfig] = await Promise.all([request, response])

    expect(requestConfig.headers.get('Authorization')).toBe('Bearer shared-access-token')
    expect(axiosInstance.request).toHaveBeenCalledTimes(1)
  })

  it('installs and ejects request and response interceptors', () => {
    const axiosInstance = createAxiosInstance()

    const installed = applyTokenRefreshMiddleware(axiosInstance, {
      getAccessToken: () => 'access-token',
      getRefreshToken: () => 'refresh-token',
      requestTokens: jest.fn(),
      onRefreshAndAccessExpire: jest.fn()
    })

    expect(installed.requestInterceptorId).toBe(1)
    expect(installed.responseInterceptorId).toBe(2)

    installed.eject()

    expect(axiosInstance.interceptors.request.eject).toHaveBeenCalledWith(1)
    expect(axiosInstance.interceptors.response.eject).toHaveBeenCalledWith(2)
  })
})

describe('crossTabLock', () => {
  let originalLocalStorage: Storage | undefined

  beforeEach(() => {
    originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage
    ;(globalThis as { localStorage?: Storage }).localStorage = createMemoryStorage()
  })

  afterEach(() => {
    jest.useRealTimers()
    ;(globalThis as { localStorage?: Storage }).localStorage = originalLocalStorage
  })

  it('waits for another instance holding the lock instead of also calling requestTokens', async () => {
    jest.useFakeTimers()

    let sharedAccessToken: string | undefined
    let sharedRefreshToken: string | undefined = 'shared-refresh-token'

    let resolveLeaderRefresh: ((tokens: { accessToken: string; refreshToken: string }) => void) | undefined
    const leaderRequestTokens = jest.fn(
      () =>
        new Promise<{ accessToken: string; refreshToken: string }>((resolve) => {
          resolveLeaderRefresh = resolve
        })
    )
    const followerRequestTokens = jest.fn().mockResolvedValue({
      accessToken: 'follower-own-token',
      refreshToken: 'follower-own-refresh'
    })

    const commonOptions = {
      getAccessToken: () => sharedAccessToken,
      getRefreshToken: () => sharedRefreshToken,
      setTokens: (tokens: { accessToken: string; refreshToken?: string }) => {
        sharedAccessToken = tokens.accessToken

        if (tokens.refreshToken) {
          sharedRefreshToken = tokens.refreshToken
        }
      },
      onRefreshAndAccessExpire: jest.fn(),
      crossTabLock: true,
      crossTabLockKey: 'shared-lock-key',
      timeoutRequest: 5000
    }

    const leaderMiddleware = createTokenRefreshMiddleware({ ...commonOptions, requestTokens: leaderRequestTokens })
    const followerMiddleware = createTokenRefreshMiddleware({ ...commonOptions, requestTokens: followerRequestTokens })

    const leaderRequest = leaderMiddleware(createConfig())
    await flushPromises()

    const followerRequest = followerMiddleware(createConfig())
    await flushPromises()

    // Leader holds the lock - follower must not have started its own refresh yet.
    expect(followerRequestTokens).not.toHaveBeenCalled()

    if (!resolveLeaderRefresh) {
      throw new Error('Leader refresh resolver was not initialized')
    }

    resolveLeaderRefresh({ accessToken: 'leader-token', refreshToken: 'leader-refresh' })
    await leaderRequest

    // Give the follower's lock-release poll a chance to observe the released lock.
    await jest.advanceTimersByTimeAsync(200)

    const followerConfig = await followerRequest

    expect(followerRequestTokens).not.toHaveBeenCalled()
    expect(followerConfig.headers.get('Authorization')).toBe('Bearer leader-token')
  })

  it('does nothing when localStorage is unavailable', async () => {
    ;(globalThis as { localStorage?: Storage }).localStorage = undefined

    const requestTokens = jest.fn().mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token'
    })

    const middleware = createTokenRefreshMiddleware({
      getAccessToken: () => undefined,
      getRefreshToken: () => 'refresh-token',
      requestTokens,
      onRefreshAndAccessExpire: jest.fn(),
      crossTabLock: true,
      crossTabLockKey: 'no-storage-key'
    })

    const config = await middleware(createConfig())

    expect(requestTokens).toHaveBeenCalledTimes(1)
    expect(config.headers.get('Authorization')).toBe('Bearer access-token')
  })
})
