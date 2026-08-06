/**
 * Best-effort coordination between browser tabs/windows sharing the same token storage
 * (cookies, localStorage-backed custom storage, etc). It reduces the chance that two tabs
 * call `requestTokens()` at the same time and race a single-use rotating refresh token -
 * it does not guarantee mutual exclusion. If the lock holder does not finish in time, a
 * waiting tab gives up and refreshes on its own rather than hanging past its own timeout.
 */

const LOCK_STORAGE_PREFIX = 'jwt-refresh-lock:'
const LOCK_POLL_INTERVAL_MS = 75

type LockPayload = {
  owner: string
  expiresAt: number
}

type StorageEventListener = (event: { key?: string | null }) => void

type GlobalWithStorageEvents = typeof globalThis & {
  addEventListener?: (type: 'storage', listener: StorageEventListener) => void
  removeEventListener?: (type: 'storage', listener: StorageEventListener) => void
}

export type CrossTabLock = {
  /**
   * Attempts to take the lock for `ttlMs`. Returns a fresh owner id if acquired, or undefined if
   * someone else already holds it. Each call mints its own id (rather than reusing one fixed per
   * `createCrossTabLock`) so a slow/abandoned attempt can never release a *later* attempt's lock -
   * `release` only clears the entry when the id still matches.
   */
  acquire: (ttlMs: number) => string | undefined
  /** Releases the lock, but only if it is still held under `ownerId`. */
  release: (ownerId: string) => void
  /** Resolves once the lock is free (or expired), or after `timeoutMs`, whichever comes first. */
  waitForRelease: (timeoutMs: number) => Promise<void>
}

const randomOwnerId = (): string => {
  const cryptoObj = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto

  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const getLocalStorage = (): Storage | undefined => {
  try {
    const storage = (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage
    return typeof storage?.getItem === 'function' ? storage : undefined
  } catch {
    // Accessing localStorage can throw (e.g. sandboxed iframes, privacy mode).
    return undefined
  }
}

export const createCrossTabLock = (key: string): CrossTabLock | undefined => {
  const storage = getLocalStorage()

  if (!storage) {
    return undefined
  }

  const storageKey = `${LOCK_STORAGE_PREFIX}${key}`

  const readLock = (): LockPayload | undefined => {
    try {
      const raw = storage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as LockPayload) : undefined
    } catch {
      return undefined
    }
  }

  const isLockActive = (lock: LockPayload | undefined): boolean => !!lock && lock.expiresAt > Date.now()

  const acquire = (ttlMs: number): string | undefined => {
    if (isLockActive(readLock())) {
      return undefined
    }

    const ownerId = randomOwnerId()

    try {
      storage.setItem(storageKey, JSON.stringify({ owner: ownerId, expiresAt: Date.now() + ttlMs }))
      return ownerId
    } catch {
      return undefined
    }
  }

  const release = (ownerId: string) => {
    const existing = readLock()

    if (existing?.owner === ownerId) {
      try {
        storage.removeItem(storageKey)
      } catch {
        // Ignore - the lock will still expire on its own via expiresAt.
      }
    }
  }

  const waitForRelease = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      let settled = false

      const finish = () => {
        if (settled) {
          return
        }

        settled = true
        clearInterval(pollInterval)
        clearTimeout(giveUpTimeout)

        const globalWithEvents = globalThis as GlobalWithStorageEvents
        if (typeof globalWithEvents.removeEventListener === 'function') {
          globalWithEvents.removeEventListener('storage', onStorageEvent)
        }

        resolve()
      }

      const checkLock = () => {
        if (!isLockActive(readLock())) {
          finish()
        }
      }

      const onStorageEvent: StorageEventListener = (event) => {
        if (event.key === storageKey || event.key == null) {
          checkLock()
        }
      }

      const pollInterval = setInterval(checkLock, LOCK_POLL_INTERVAL_MS)
      const giveUpTimeout = setTimeout(finish, timeoutMs)

      const globalWithEvents = globalThis as GlobalWithStorageEvents
      if (typeof globalWithEvents.addEventListener === 'function') {
        globalWithEvents.addEventListener('storage', onStorageEvent)
      }

      checkLock()
    })

  return { acquire, release, waitForRelease }
}
