import { InternalAxiosRequestConfig } from 'axios'
import Cookies, { CookieAttributes } from 'js-cookie'
import { CreateTokenRefreshMiddleware } from './types'

let isRefreshing = false
const timedoutRequestsQueue: [NodeJS.Timeout, (value: unknown) => void][] = []
const TIMEOUT_REQUEST = 30000

export const createTokenRefreshMiddleware = (options: CreateTokenRefreshMiddleware) => async (config: InternalAxiosRequestConfig) => {
  const {
    accessTokenKey,
    refreshTokenKey,
    timeoutRequest = TIMEOUT_REQUEST,
    cookiesOptions = {},
    requestTokens,
    onRefreshAndAccessExpire
  } = options

  const accessToken = Cookies.get(accessTokenKey)
  const refreshToken = Cookies.get(refreshTokenKey)

  if (isRefreshing) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, timeoutRequest)
      timedoutRequestsQueue.push([timeout, resolve])
    })

    const accessToken = Cookies.get(accessTokenKey)
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`
    }
    return config
  }

  if (!accessToken && refreshToken) {
    isRefreshing = true

    try {
      const tokens = await requestTokens()

      if (tokens.accessToken) {
        Cookies.set(accessTokenKey, tokens.accessToken, cookiesOptions)
      }
      if (tokens.refreshToken) {
        Cookies.set(refreshTokenKey, tokens.refreshToken, cookiesOptions)
      }

      for (let i = 0; i < timedoutRequestsQueue.length; i++) {
        const [timeout, resolver] = timedoutRequestsQueue[i]
        clearTimeout(timeout)
        resolver(true)
      }
    } catch (error) {
      onRefreshAndAccessExpire()
    } finally {
      timedoutRequestsQueue.length = 0
      isRefreshing = false
    }
  }

  if (!accessToken && !refreshToken) {
    onRefreshAndAccessExpire()
    return config
  }

  const accessKey = Cookies.get(accessTokenKey)
  if (accessKey) {
    config.headers.Authorization = `Bearer ${accessKey}`
  }

  return config
}