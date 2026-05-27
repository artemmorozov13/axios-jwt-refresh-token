"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTokenRefreshMiddleware = void 0;
const js_cookie_1 = __importDefault(require("js-cookie"));
let isRefreshing = false;
const timedoutRequestsQueue = [];
const TIMEOUT_REQUEST = 30000;
const createTokenRefreshMiddleware = (options) => (config) => __awaiter(void 0, void 0, void 0, function* () {
    const { accessTokenKey, refreshTokenKey, timeoutRequest = TIMEOUT_REQUEST, requestTokens, setCookiesFunction, onRefreshAndAccessExpire } = options;
    const accessToken = js_cookie_1.default.get(accessTokenKey);
    const refreshToken = js_cookie_1.default.get(refreshTokenKey);
    if (isRefreshing) {
        yield new Promise((resolve) => {
            const timeout = setTimeout(resolve, timeoutRequest);
            timedoutRequestsQueue.push([timeout, resolve]);
        });
        const accessToken = js_cookie_1.default.get(accessTokenKey);
        if (accessToken) {
            config.headers.Authorization = `Bearer ${accessToken}`;
        }
        return config;
    }
    if (!accessToken && refreshToken) {
        isRefreshing = true;
        try {
            const tokens = yield requestTokens();
            setCookiesFunction();
            for (let i = 0; i < timedoutRequestsQueue.length; i++) {
                const [timeout, resolver] = timedoutRequestsQueue[i];
                clearTimeout(timeout);
                resolver(true);
            }
        }
        catch (error) {
            onRefreshAndAccessExpire();
        }
        finally {
            timedoutRequestsQueue.length = 0;
            isRefreshing = false;
        }
    }
    if (!accessToken && !refreshToken) {
        onRefreshAndAccessExpire();
        return config;
    }
    const accessKey = js_cookie_1.default.get(accessTokenKey);
    if (accessKey) {
        config.headers.Authorization = `Bearer ${accessKey}`;
    }
    return config;
});
exports.createTokenRefreshMiddleware = createTokenRefreshMiddleware;
