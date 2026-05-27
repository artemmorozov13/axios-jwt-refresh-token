import { CookieAttributes } from 'js-cookie';

export interface RequestAccessTokenResponse {
  accessToken: string;
  refreshToken: string;
}

export interface CreateTokenRefreshMiddleware {
  requestTokens: () => Promise<RequestAccessTokenResponse>;
  onRefreshAndAccessExpire: () => void;
  setCookiesFunction: () => void; 
  accessTokenKey: string;
  refreshTokenKey: string;
  timeoutRequest?: number;
}