import { AxiosError, AxiosHeaders, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import {
  CreateTokenRefreshMiddleware,
  RequestAccessTokenResponse,
  TokenRefreshInterceptors
} from './types'
import { createCrossTabLock } from './cross-tab-lock'

const TIMEOUT_REQUEST = 30000
const DEFAULT_STATUS_CODES = [401]
const RETRY_FLAG = '_jwtRefreshRetry'
const DEFAULT_CROSS_TAB_LOCK_KEY = 'jwt-token-refresh-middleware'

type RefreshRetryConfig = InternalAxiosRequestConfig & {
  [RETRY_FLAG]?: boolean
}

type QueueItem = {
  resolve: (tokens: RequestAccessTokenResponse) => void
  reject: (error: unknown) => void
}

type JsCookieModule = {
  default?: {
    get: (name: string) => string | undefined
  }
  get?: (name: string) => string | undefined
}

export class TokenRefreshError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'TokenRefreshError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class TokenRefreshTimeoutError extends TokenRefreshError {
  constructor(timeoutRequest: number) {
    super(`Token refresh timed out after ${timeoutRequest}ms`)
    this.name = 'TokenRefreshTimeoutError'
  }
}

export class AuthTokensMissingError extends TokenRefreshError {
  constructor() {
    super('Access token and refresh token are missing')
    this.name = 'AuthTokensMissingError'
  }
}

export class TokenStorageError extends TokenRefreshError {
  constructor(message: string, cause?: unknown) {
    super(message, cause)
    this.name = 'TokenStorageError'
  }
}

const decodeBase64Url = (value: string): string | undefined => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')

  if (typeof globalThis.atob === 'function') {
    return globalThis.atob(padded)
  }

  const buffer = (globalThis as typeof globalThis & {
    Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } }
  }).Buffer

  return buffer?.from(padded, 'base64').toString('utf-8')
}

const isJwtExpired = (token: string, refreshBeforeExpirationMs: number): boolean => {
  const [, payload] = token.split('.')

  // Not JWT-shaped (no payload segment) - likely an opaque token. Don't force a refresh loop
  // over it; let the response interceptor handle a 401 if the server rejects it.
  if (!payload) {
    return false
  }

  // From here the token looks like a JWT but its claims can't be trusted, so fail safe and
  // treat it as expired rather than sending a token we can't verify.
  try {
    const decodedPayload = decodeBase64Url(payload)

    if (!decodedPayload) {
      return true
    }

    const parsedPayload = JSON.parse(decodedPayload) as { exp?: unknown }

    if (typeof parsedPayload.exp !== 'number') {
      return true
    }

    return parsedPayload.exp * 1000 <= Date.now() + refreshBeforeExpirationMs
  } catch {
    return true
  }
}

const createTimeoutPromise = <T>(promise: Promise<T>, timeoutRequest: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout>

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new TokenRefreshTimeoutError(timeoutRequest)), timeoutRequest)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
}

const setAuthorizationHeader = (
  config: InternalAxiosRequestConfig,
  token: string,
  headerName: string,
  headerPrefix: string
) => {
  const headerValue = headerPrefix ? `${headerPrefix} ${token}` : token

  if (!config.headers) {
    config.headers = new AxiosHeaders()
  }

  if (typeof config.headers.set === 'function') {
    config.headers.set(headerName, headerValue)
    return
  }

  config.headers[headerName] = headerValue
}

const getCookieValue = async (key: string | undefined, tokenType: 'access' | 'refresh') => {
  if (!key) {
    throw new TokenStorageError(
      `Missing ${tokenType} token storage. Provide get${tokenType === 'access' ? 'Access' : 'Refresh'}Token or ${tokenType}TokenKey.`
    )
  }

  try {
    const cookieModule = await import('js-cookie') as JsCookieModule
    const cookies = cookieModule.default || cookieModule

    if (typeof cookies.get !== 'function') {
      throw new Error('js-cookie does not expose get()')
    }

    return cookies.get(key)
  } catch (error) {
    throw new TokenStorageError(
      'js-cookie is required for cookie-based token storage. Install it or provide custom token storage callbacks.',
      error
    )
  }
}

const normalizeRefreshError = (error: unknown) =>
  error instanceof TokenRefreshError ? error : new TokenRefreshError('Token refresh failed', error)

export const createTokenRefreshInterceptors = (options: CreateTokenRefreshMiddleware): TokenRefreshInterceptors => {
  const {
    accessTokenKey,
    refreshTokenKey,
    timeoutRequest = TIMEOUT_REQUEST,
    refreshBeforeExpirationMs = 0,
    statusCodes = DEFAULT_STATUS_CODES,
    authorizationHeaderName = 'Authorization',
    authorizationHeaderPrefix = 'Bearer',
    requestTokens,
    setTokens,
    setCookiesFunction,
    onRefreshAndAccessExpire,
    getAccessToken = () => getCookieValue(accessTokenKey, 'access'),
    getRefreshToken = () => getCookieValue(refreshTokenKey, 'refresh'),
    shouldRefreshAccessToken = (accessToken) => !accessToken || isJwtExpired(accessToken, refreshBeforeExpirationMs),
    shouldRetryResponse,
    shouldSkip,
    crossTabLock: crossTabLockEnabled = false,
    crossTabLockKey = accessTokenKey || refreshTokenKey || DEFAULT_CROSS_TAB_LOCK_KEY
  } = options

  let refreshPromise: Promise<RequestAccessTokenResponse> | null = null
  const requestsQueue: QueueItem[] = []
  const persistTokens = setTokens || setCookiesFunction || (() => undefined)
  const crossTabLock = crossTabLockEnabled ? createCrossTabLock(crossTabLockKey) : undefined

  const settleQueue = (callback: (queueItem: QueueItem) => void) => {
    const queue = requestsQueue.splice(0)

    for (let i = 0; i < queue.length; i++) {
      callback(queue[i])
    }
  }

  // The leader's own createTimeoutPromise(...) below always settles within timeoutRequest and
  // always runs settleQueue on both success and failure, so a follower's promise here is always
  // settled by the leader - it never needs a timeout of its own.
  const waitForRefresh = () =>
    new Promise<RequestAccessTokenResponse>((resolve, reject) => {
      requestsQueue.push({ resolve, reject })
    })

  type LockAcquisition = { ownerId: string | undefined }
  type OtherTabResult = { tokens: RequestAccessTokenResponse }

  // Best-effort: if another tab already holds the cross-tab lock, wait for it to finish instead
  // of also calling requestTokens(). Returns the tokens read from shared storage when the other
  // tab's refresh appears to have landed, or a lock acquisition for this tab to refresh itself.
  const acquireLockOrWaitForOtherTab = async (): Promise<LockAcquisition | OtherTabResult> => {
    if (!crossTabLock) {
      return { ownerId: undefined }
    }

    const ownerId = crossTabLock.acquire(timeoutRequest)

    if (ownerId) {
      return { ownerId }
    }

    const tokenBeforeWait = await getAccessToken()

    // Leave some of the budget for our own refresh call in case the other tab never releases.
    await crossTabLock.waitForRelease(Math.max(1000, Math.floor(timeoutRequest / 2)))

    const tokenAfterWait = await getAccessToken()

    if (tokenAfterWait && tokenAfterWait !== tokenBeforeWait) {
      return { tokens: { accessToken: tokenAfterWait, refreshToken: await getRefreshToken() } }
    }

    return { ownerId: crossTabLock.acquire(timeoutRequest) }
  }

  const refreshTokens = async () => {
    if (!refreshPromise) {
      const executeRefresh = async () => {
        const lockResult = await acquireLockOrWaitForOtherTab()

        if ('tokens' in lockResult) {
          settleQueue((queueItem) => queueItem.resolve(lockResult.tokens))
          return lockResult.tokens
        }

        try {
          const tokens = await requestTokens()

          await persistTokens(tokens)
          settleQueue((queueItem) => queueItem.resolve(tokens))

          return tokens
        } finally {
          // Only releases if this attempt's ownerId still holds the lock, so a delayed finally
          // from an abandoned/timed-out attempt can never clobber a later attempt's lock.
          if (lockResult.ownerId) {
            crossTabLock?.release(lockResult.ownerId)
          }
        }
      }

      refreshPromise = createTimeoutPromise(executeRefresh(), timeoutRequest).catch((error) => {
        const refreshError = normalizeRefreshError(error)

        settleQueue((queueItem) => queueItem.reject(refreshError))
        throw refreshError
      }).finally(() => {
        refreshPromise = null
      })
    }

    return refreshPromise
  }

  const getFreshTokens = () => refreshPromise ? waitForRefresh() : refreshTokens()

  const getLatestAccessToken = async (tokens: RequestAccessTokenResponse) => {
    const storedAccessToken = await getAccessToken()

    return storedAccessToken || tokens.accessToken
  }

  const handleExpiredSession = async (error: unknown): Promise<never> => {
    await onRefreshAndAccessExpire(error)
    throw error
  }

  const request = async (config: InternalAxiosRequestConfig) => {
    if (shouldSkip?.(config)) {
      return config
    }

    const accessToken = await getAccessToken()

    if (!(await shouldRefreshAccessToken(accessToken, config))) {
      if (accessToken) {
        setAuthorizationHeader(config, accessToken, authorizationHeaderName, authorizationHeaderPrefix)
      }

      return config
    }

    const refreshToken = await getRefreshToken()

    if (!refreshToken) {
      return handleExpiredSession(new AuthTokensMissingError())
    }

    try {
      const refreshedTokens = await getFreshTokens()
      const latestAccessToken = await getLatestAccessToken(refreshedTokens)

      if (latestAccessToken) {
        setAuthorizationHeader(config, latestAccessToken, authorizationHeaderName, authorizationHeaderPrefix)
      }

      return config
    } catch (error) {
      return handleExpiredSession(error)
    }
  }

  const shouldHandleResponseError = async (error: AxiosError) => {
    const config = error.config as RefreshRetryConfig | undefined

    if (!config || config[RETRY_FLAG] || shouldSkip?.(config)) {
      return false
    }

    if (shouldRetryResponse) {
      return shouldRetryResponse(error)
    }

    const status = error.response?.status

    return typeof status === 'number' && statusCodes.includes(status)
  }

  const responseError = (axiosInstance: AxiosInstance) => async (error: AxiosError): Promise<AxiosResponse> => {
    if (!(await shouldHandleResponseError(error))) {
      throw error
    }

    const config = error.config as RefreshRetryConfig
    const refreshToken = await getRefreshToken()

    if (!refreshToken) {
      return handleExpiredSession(new AuthTokensMissingError())
    }

    config[RETRY_FLAG] = true

    try {
      const refreshedTokens = await getFreshTokens()
      const latestAccessToken = await getLatestAccessToken(refreshedTokens)

      if (latestAccessToken) {
        setAuthorizationHeader(config, latestAccessToken, authorizationHeaderName, authorizationHeaderPrefix)
      }

      return axiosInstance.request(config)
    } catch (refreshError) {
      return handleExpiredSession(refreshError)
    }
  }

  return {
    request,
    responseError
  }
}

export const createTokenRefreshMiddleware = (options: CreateTokenRefreshMiddleware) =>
  createTokenRefreshInterceptors(options).request

export const createTokenRefreshResponseInterceptor = (
  axiosInstance: AxiosInstance,
  options: CreateTokenRefreshMiddleware
) => createTokenRefreshInterceptors(options).responseError(axiosInstance)

export const applyTokenRefreshMiddleware = (axiosInstance: AxiosInstance, options: CreateTokenRefreshMiddleware) => {
  const interceptors = createTokenRefreshInterceptors(options)
  const requestInterceptorId = axiosInstance.interceptors.request.use(interceptors.request)
  const responseInterceptorId = axiosInstance.interceptors.response.use(undefined, interceptors.responseError(axiosInstance))

  return {
    requestInterceptorId,
    responseInterceptorId,
    eject: () => {
      axiosInstance.interceptors.request.eject(requestInterceptorId)
      axiosInstance.interceptors.response.eject(responseInterceptorId)
    }
  }
}

export * from './types'
