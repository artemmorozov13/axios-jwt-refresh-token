import Cookies from 'js-cookie'
import { createCookieTokenStorage } from './cookie-storage'

jest.mock('js-cookie', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    set: jest.fn()
  }
}))

const getCookieMock = Cookies.get as jest.Mock
const setCookieMock = Cookies.set as jest.Mock

describe('createCookieTokenStorage', () => {
  it('reads access and refresh tokens from cookies', () => {
    getCookieMock.mockImplementation((key: string) => (key === 'accessToken' ? 'access-value' : 'refresh-value'))

    const storage = createCookieTokenStorage({ accessTokenKey: 'accessToken', refreshTokenKey: 'refreshToken' })

    expect(storage.getAccessToken()).toBe('access-value')
    expect(storage.getRefreshToken()).toBe('refresh-value')
  })

  it('sets both cookies when a refresh token is returned', () => {
    const storage = createCookieTokenStorage({ accessTokenKey: 'accessToken', refreshTokenKey: 'refreshToken' })

    storage.setTokens?.({ accessToken: 'new-access', refreshToken: 'new-refresh' })

    expect(setCookieMock).toHaveBeenCalledWith('accessToken', 'new-access', undefined)
    expect(setCookieMock).toHaveBeenCalledWith('refreshToken', 'new-refresh', undefined)
  })

  it('only sets the access token cookie when no refresh token is returned', () => {
    const storage = createCookieTokenStorage({ accessTokenKey: 'accessToken', refreshTokenKey: 'refreshToken' })

    storage.setTokens?.({ accessToken: 'new-access' })

    expect(setCookieMock).toHaveBeenCalledWith('accessToken', 'new-access', undefined)
    expect(setCookieMock).not.toHaveBeenCalledWith('refreshToken', expect.anything(), expect.anything())
  })
})
