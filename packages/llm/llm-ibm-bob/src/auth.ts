/**
 * IBM Bob Gateway authentication: SSO token exchange/refresh, local callback
 * server for the OAuth redirect, and non-secret settings discovery from
 * `~/.bob/settings.json`.
 *
 * Token format is {access, refresh, expires}: the access token is a JWT whose
 * `exp` claim is the authoritative expiry; `expires_in` from the token response
 * is the fallback when the JWT cannot be decoded.
 *
 * The Bob Gateway sits behind Cloudflare, which blocks any User-Agent
 * containing "opencode". Use a neutral User-Agent on every request.
 *
 * @module @deepseek-ai/dsh-llm-ibm-bob/auth
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'

// ─── Constants ──────────────────────────────────────────────────────────────

/** The scope every credential record this plugin writes is stored under. */
export const RECORD_SCOPE = 'llm-ibm-bob'

/** The single provider route this plugin owns. */
export const PROVIDER = 'ibm-bob'

/** Credential record key for this plugin's stored OAuth grant or API key. */
export const CREDENTIAL_KEY: CredentialKey = credentialKey(RECORD_SCOPE, PROVIDER)

/** Default Bob inference base URL. */
export const DEFAULT_BASE_URL = 'https://api.us-east.bob.ibm.com/inference/v1'

/** Default Bob auth base URL (derived by stripping `/inference/v1`). */
export const DEFAULT_AUTH_BASE_URL = 'https://api.us-east.bob.ibm.com'

/** User-Agent sent to the Bob Gateway and auth endpoints.
 * Must resemble Bob Shell's Electron UA — Cloudflare blocks non-browser agents.
 */
export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) bob-shell/1.0.6 Chrome/130.0.6723.191 Electron/33.3.1 Safari/537.36'

/** Path the local callback server listens on. */
export const CALLBACK_PATH = '/bob-shell-auth-callback'

/** Milliseconds before the local OAuth callback server times out. */
const TOKEN_TIMEOUT_MS = 180_000

/** Default token lifetime assumed when the JWT carries no `exp` and the server sends no `expires_in`. */
const DEFAULT_TOKEN_TTL_MS = 8 * 60 * 60 * 1_000

/** Milliseconds before token expiry at which a refresh is triggered proactively. */
export const TOKEN_REFRESH_SKEW_MS = 60_000

// ─── Token types ────────────────────────────────────────────────────────────

/** A successfully exchanged or refreshed token pair. */
export interface TokenSuccess {
  readonly type: 'success'
  readonly access: string
  readonly refresh: string
  /** Unix epoch milliseconds at which `access` is considered expired. */
  readonly expires: number
}

/** Outcome when a token exchange or refresh did not return usable credentials. */
export interface TokenFailed {
  readonly type: 'failed'
}

export type TokenResult = TokenSuccess | TokenFailed

/** The grant payload persisted in the harness credential store. */
export interface BobGrantPayload {
  readonly type: 'oauth'
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

// ─── Bob Shell settings ──────────────────────────────────────────────────────

/** Non-secret routing headers read from `~/.bob/settings.json`. */
export interface BobShellSelector {
  readonly instanceId: string | undefined
  readonly teamId: string | undefined
}

/**
 * Read `ibm.instanceId` and `ibm.teamId` from `~/.bob/settings.json`.
 * Returns `undefined` for each field that is absent or cannot be read.
 * Never throws: a missing or malformed file is treated as no selector.
 */
export function readBobShellSelector(): BobShellSelector {
  try {
    const raw = readFileSync(join(homedir(), '.bob', 'settings.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { instanceId: undefined, teamId: undefined }
    }
    const ibm = (parsed as Record<string, unknown>)['ibm']
    if (ibm === null || typeof ibm !== 'object' || Array.isArray(ibm)) {
      return { instanceId: undefined, teamId: undefined }
    }
    const settings = ibm as Record<string, unknown>
    const instanceId = typeof settings['instanceId'] === 'string' ? settings['instanceId'].trim() || undefined : undefined
    const teamId = typeof settings['teamId'] === 'string' ? settings['teamId'].trim() || undefined : undefined
    return { instanceId, teamId }
  } catch {
    return { instanceId: undefined, teamId: undefined }
  }
}

// ─── JWT helpers ─────────────────────────────────────────────────────────────

function decodeJwtExp(token: string): number | undefined {
  try {
    const segment = token.split('.')[1]
    if (segment === undefined) return undefined
    const payload: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    if (typeof payload === 'object' && payload !== null && 'exp' in payload) {
      const exp = (payload as { exp: unknown }).exp
      return typeof exp === 'number' ? exp * 1_000 : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

interface RequestJsonInit extends RequestInit {
  headers?: Record<string, string>
}

async function requestJson(url: string | URL, init: RequestJsonInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
      ...init.headers,
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const error: Error & { status?: number } = new Error(
      `${response.status} ${response.statusText}${body ? `: ${body}` : ''}`,
    )
    error.status = response.status
    throw error
  }
  return response.json()
}

function parseTokenResult(json: unknown): TokenResult {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { type: 'failed' }
  const obj = json as Record<string, unknown>
  const access = typeof obj['token'] === 'string' ? obj['token']
    : typeof obj['access_token'] === 'string' ? obj['access_token']
    : undefined
  const refresh = typeof obj['refresh_token'] === 'string' ? obj['refresh_token'] : undefined
  if (access === undefined || refresh === undefined) return { type: 'failed' }
  const jwtExpMs = decodeJwtExp(access)
  const expiresIn = typeof obj['expires_in'] === 'number' ? obj['expires_in'] * 1_000 : DEFAULT_TOKEN_TTL_MS
  const expires = jwtExpMs ?? (Date.now() + expiresIn)
  return { type: 'success', access, refresh, expires }
}

// ─── Auth API calls ──────────────────────────────────────────────────────────

/**
 * Fetch the IBMid redirect URL from Bob's login endpoint.
 * @param authBaseURL - Bob auth base (e.g. `https://api.us-east.bob.ibm.com`).
 * @param redirectURI - The local callback URI Bob should redirect back to.
 * @param state - CSRF nonce.
 * @returns The IBMid authorization URL to open in a browser.
 */
export async function createAuthorizationURL(
  authBaseURL: string,
  redirectURI: string,
  state: string,
): Promise<string> {
  const loginURL = new URL('/authn/v1/auth/login', authBaseURL)
  loginURL.searchParams.set('redirect_uri', redirectURI)
  loginURL.searchParams.set('response_mode', 'query')
  loginURL.searchParams.set('state', state)
  const login = await requestJson(loginURL) as Record<string, unknown>
  if (typeof login['redirect_url'] !== 'string') {
    throw new Error('Bob auth login response did not include redirect_url.')
  }
  return login['redirect_url']
}

/**
 * Exchange an authorization code for an access+refresh token pair.
 * @param authBaseURL - Bob auth base URL.
 * @param code - The authorization code from the callback.
 */
export async function exchangeAuthorizationCode(authBaseURL: string, code: string): Promise<TokenResult> {
  const json = await requestJson(new URL('/authn/v1/auth/token', authBaseURL), {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  return parseTokenResult(json)
}

/**
 * Refresh an expired access token using the stored refresh token.
 * @param authBaseURL - Bob auth base URL.
 * @param refreshToken - The stored refresh token.
 */
export async function refreshAccessToken(authBaseURL: string, refreshToken: string): Promise<TokenResult> {
  const json = await requestJson(new URL('/authn/v1/auth/refresh', authBaseURL), {
    method: 'POST',
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  return parseTokenResult(json)
}

// ─── CSRF state ──────────────────────────────────────────────────────────────

/** Generate a random CSRF state nonce for the OAuth redirect. */
export function createState(): string {
  return `/${randomBytes(16).toString('hex')}`
}

// ─── Browser opener ─────────────────────────────────────────────────────────

/** Open a URL in the system browser. Never throws. */
export function openBrowser(url: string): void {
  try {
    let command = 'xdg-open'
    let args = [url]
    if (process.platform === 'darwin') {
      command = 'open'
    } else if (process.platform === 'win32') {
      command = 'cmd'
      args = ['/c', 'start', '', url]
    }
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // Opening the browser is best-effort; the login flow surfaces the URL regardless.
  }
}

// ─── Local callback server ───────────────────────────────────────────────────

export interface CallbackServer {
  readonly ready: boolean
  readonly redirectURI: string | undefined
  close(): void
  waitForCode(): Promise<{ code: string } | null>
}

/**
 * Start a local HTTP server that receives the OAuth redirect callback.
 * Returns immediately with a `CallbackServer`; if the OS cannot bind a port
 * `ready` is `false` and the flow falls back to manual URL paste.
 */
export function startCallbackServer(state: string): Promise<CallbackServer> {
  const server = createServer()
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectCode: ((err: Error) => void) | undefined

  const cleanup = (): void => {
    if (timeout !== undefined) clearTimeout(timeout)
    try { server.close() } catch { /* best-effort */ }
  }

  const settle = (callback: () => void): void => {
    if (settled) return
    settled = true
    cleanup()
    callback()
  }

  const codePromise = new Promise<{ code: string }>((resolveCode, rejectCodePromise) => {
    rejectCode = rejectCodePromise

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }

      if (url.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Invalid state parameter')
        settle(() => rejectCodePromise(new Error('Invalid state parameter.')))
        return
      }

      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Missing authorization code')
        settle(() => rejectCodePromise(new Error('Missing authorization code.')))
        return
      }

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>Authentication successful</h1><p>You can close this tab.</p></body></html>')
      settle(() => resolveCode({ code }))
    })
  })

  return new Promise((resolve) => {
    server
      .listen(0, '127.0.0.1', () => {
        timeout = setTimeout(() => {
          settle(() => rejectCode!(new Error('Authentication timed out after 3 minutes.')))
        }, TOKEN_TIMEOUT_MS)

        const address = server.address()
        const port = address !== null && typeof address === 'object' ? address.port : undefined
        resolve({
          ready: true,
          redirectURI: port !== undefined ? `http://127.0.0.1:${port}${CALLBACK_PATH}` : undefined,
          close: cleanup,
          waitForCode: () => codePromise,
        })
      })
      .on('error', () => {
        try { server.close() } catch { /* best-effort */ }
        resolve({
          ready: false,
          redirectURI: undefined,
          close: () => { /* nothing to close */ },
          waitForCode: async () => null,
        })
      })
  })
}

// ─── Authorization-code input parser ─────────────────────────────────────────

/**
 * Parse a raw string the user pasted into the manual-code prompt.
 * Accepts: a full redirect URL, `code#state`, `code=...&state=...`, or a bare code.
 */
export function parseAuthorizationInput(input: string | undefined): { code?: string; state?: string } {
  const value = (input ?? '').trim()
  if (!value) return {}

  try {
    const url = new URL(value)
    const code = url.searchParams.get('code') ?? undefined
    const state = url.searchParams.get('state') ?? undefined
    return {
      ...(code !== undefined ? { code } : {}),
      ...(state !== undefined ? { state } : {}),
    }
  } catch { /* not a URL */ }

  if (value.includes('#')) {
    const [code, maybeState] = value.split('#', 2) as [string, string | undefined]
    return {
      code,
      ...(maybeState !== undefined ? { state: maybeState } : {}),
    }
  }

  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    const code = params.get('code') ?? undefined
    const state = params.get('state') ?? undefined
    return {
      ...(code !== undefined ? { code } : {}),
      ...(state !== undefined ? { state } : {}),
    }
  }

  return { code: value }
}

// ─── Grant payload helpers ───────────────────────────────────────────────────

/** Build the JSON-serializable grant payload from a successful token exchange. */
export function toGrantPayload(result: TokenSuccess): BobGrantPayload {
  return { type: 'oauth', access: result.access, refresh: result.refresh, expires: result.expires }
}

/**
 * Whether a stored grant payload's access token should be refreshed before use.
 * True when the token is absent, expired, or expires within the refresh skew window.
 */
export function isExpired(payload: BobGrantPayload): boolean {
  return payload.expires - TOKEN_REFRESH_SKEW_MS <= Date.now()
}
