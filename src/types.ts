import type { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios'

export type MaybePromise<T> = T | Promise<T>

export interface RequestAccessTokenResponse {
  accessToken: string
  /** Optional so backends that only rotate the access token don't need to fake a refresh token. */
  refreshToken?: string
}

export interface TokenStorage {
  getAccessToken: () => MaybePromise<string | undefined>
  getRefreshToken: () => MaybePromise<string | undefined>
  setTokens?: (tokens: RequestAccessTokenResponse) => MaybePromise<void>
}

export interface CookieTokenStorageOptions {
  accessTokenKey: string
  refreshTokenKey: string
}

export interface CreateTokenRefreshMiddleware {
  requestTokens: () => MaybePromise<RequestAccessTokenResponse>
  onRefreshAndAccessExpire: (error?: unknown) => MaybePromise<void>
  setTokens?: (tokens: RequestAccessTokenResponse) => MaybePromise<void>
  setCookiesFunction?: (tokens: RequestAccessTokenResponse) => MaybePromise<void>
  accessTokenKey?: string
  refreshTokenKey?: string
  timeoutRequest?: number
  refreshBeforeExpirationMs?: number
  statusCodes?: number[]
  shouldRefreshAccessToken?: (
    accessToken: string | undefined,
    config: InternalAxiosRequestConfig
  ) => MaybePromise<boolean>
  shouldRetryResponse?: (error: AxiosError) => MaybePromise<boolean>
  shouldSkip?: (config: InternalAxiosRequestConfig) => boolean
  getAccessToken?: () => MaybePromise<string | undefined>
  getRefreshToken?: () => MaybePromise<string | undefined>
  authorizationHeaderName?: string
  authorizationHeaderPrefix?: string
  /**
   * Best-effort coordination across browser tabs/windows via `localStorage`, so they don't all
   * call `requestTokens` at once when they share the same token storage. Disabled by default;
   * opt in when several tabs can read/write the same tokens. No-ops outside browsers.
   */
  crossTabLock?: boolean
  /** Lock key used when `crossTabLock` is enabled. Defaults to `accessTokenKey` or `refreshTokenKey`. */
  crossTabLockKey?: string
}

export interface TokenRefreshInterceptors {
  request: (config: InternalAxiosRequestConfig) => Promise<InternalAxiosRequestConfig>
  responseError: (axiosInstance: AxiosInstance) => (error: AxiosError) => Promise<AxiosResponse>
}

export type TokenRefreshInstaller = (axiosInstance: AxiosInstance, options: CreateTokenRefreshMiddleware) => {
  requestInterceptorId: number
  responseInterceptorId: number
  eject: () => void
}
