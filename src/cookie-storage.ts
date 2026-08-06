import Cookies, { CookieAttributes } from 'js-cookie'
import { CookieTokenStorageOptions, RequestAccessTokenResponse, TokenStorage } from './types'

export interface CreateCookieTokenStorageOptions extends CookieTokenStorageOptions {
  accessTokenCookieOptions?: CookieAttributes
  refreshTokenCookieOptions?: CookieAttributes
}

export const createCookieTokenStorage = ({
  accessTokenKey,
  refreshTokenKey,
  accessTokenCookieOptions,
  refreshTokenCookieOptions
}: CreateCookieTokenStorageOptions): TokenStorage => ({
  getAccessToken: () => Cookies.get(accessTokenKey),
  getRefreshToken: () => Cookies.get(refreshTokenKey),
  setTokens: (tokens: RequestAccessTokenResponse) => {
    Cookies.set(accessTokenKey, tokens.accessToken, accessTokenCookieOptions)

    if (tokens.refreshToken) {
      Cookies.set(refreshTokenKey, tokens.refreshToken, refreshTokenCookieOptions)
    }
  }
})

export type { CookieAttributes }
