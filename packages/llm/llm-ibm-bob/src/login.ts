/**
 * IBM Bob Gateway authorization flow for `ctx.authz`.
 *
 * Registers two methods under the plugin's credential key:
 * - `oauth-auto`  — opens a browser window and waits for the redirect callback
 * - `oauth-paste` — prints the authorization URL and asks the user to paste the redirect URL
 *
 * Both exchange the authorization code for tokens, persist them as a `grant`
 * record in `ctx.credentials`, and return. The `llm-ibm-bob` adapter reads that
 * record on the next request.
 *
 * @module @deepseek-ai/dsh-llm-ibm-bob/login
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationFlow } from '@deepseek-ai/dsh-authorization'
import {
  CREDENTIAL_KEY,
  createState,
  createAuthorizationURL,
  exchangeAuthorizationCode,
  openBrowser,
  parseAuthorizationInput,
  startCallbackServer,
  toGrantPayload,
} from './auth.ts'

/** The base URL resolver the login flow uses, evaluated lazily per login attempt. */
export type AuthBaseURLResolver = () => string

/**
 * Register the IBM Bob OAuth login flow with `ctx.authz`.
 *
 * Must be called inside `ctx.inject(['authorization'], ...)` so it is only
 * attempted when the authorization seam is present (headless compositions
 * have no surface to display a browser prompt to).
 *
 * @param ctx - the plugin context carrying `ctx.authz` and `ctx.credentials`.
 * @param authBaseURL - lazy resolver for the current auth base URL.
 */
export function registerBobLoginFlow(ctx: Context, authBaseURL: AuthBaseURLResolver): void {
  const flow: AuthorizationFlow = {
    key: CREDENTIAL_KEY,
    label: 'IBM Bob Gateway',
    methods: [
      { id: 'oauth-auto',  label: 'Sign in with IBMid (browser)' },
      { id: 'oauth-paste', label: 'Sign in with IBMid (paste URL)' },
    ],
    async run(session) {
      const base = authBaseURL()
      const state = createState()

      if (session.method === 'oauth-auto') {
        // Start the local callback server; fall back to paste if binding fails.
        const server = await startCallbackServer(state)

        let authURL: string
        try {
          authURL = await createAuthorizationURL(
            base,
            server.redirectURI ?? 'http://127.0.0.1:1455/bob-shell-auth-callback',
            state,
          )
        } catch (err) {
          server.close()
          throw err
        }

        if (server.ready) {
          openBrowser(authURL)
          session.notify({
            message: 'A browser window should open for IBMid authentication. If it does not, open the URL manually.',
            url: authURL,
          })

          let codeResult: { code: string } | null
          try {
            codeResult = await Promise.race([
              server.waitForCode(),
              new Promise<never>((_resolve, reject) => {
                session.signal.addEventListener('abort', () => {
                  server.close()
                  reject(session.signal.reason)
                }, { once: true })
              }),
            ])
          } finally {
            server.close()
          }

          if (codeResult === null) {
            throw new Error('IBM Bob OAuth callback did not return an authorization code.')
          }

          const result = await exchangeAuthorizationCode(base, codeResult.code)
          if (result.type !== 'success') {
            throw new Error('IBM Bob token exchange failed.')
          }

          const credentials = ctx.get('credentials') as CredentialProvider | undefined
          if (credentials === undefined) throw new Error('llm-ibm-bob: credentials service unavailable')
          await credentials.modifyRecord(CREDENTIAL_KEY, () =>
            Promise.resolve({ kind: 'grant', payload: toGrantPayload(result) }),
          )
          return
        }

        // Server did not bind — fall through to manual paste.
        server.close()
        session.notify({
          message: 'Could not start a local callback server. Open the URL and paste the full redirect URL or authorization code.',
          url: authURL,
        })
      } else {
        // oauth-paste: construct URL without a server.
        const authURL = await createAuthorizationURL(
          base,
          'http://127.0.0.1:1455/bob-shell-auth-callback',
          state,
        )
        session.notify({
          message: 'Open the URL and complete IBMid authentication, then paste the full redirect URL or authorization code here.',
          url: authURL,
        })
      }

      // Manual code entry path (both paste-only method and auto-fallback).
      const raw = await session.prompt({
        kind: 'text',
        message: 'Paste the redirect URL or authorization code:',
        signal: session.signal,
      })

      const parsed = parseAuthorizationInput(raw)
      if (parsed.code === undefined) {
        throw new Error('No authorization code found in the pasted value.')
      }
      if (parsed.state !== undefined && parsed.state !== state) {
        throw new Error('State mismatch in the pasted authorization URL. Try signing in again.')
      }

      const result = await exchangeAuthorizationCode(base, parsed.code)
      if (result.type !== 'success') {
        throw new Error('IBM Bob token exchange failed.')
      }

      const credentials = ctx.get('credentials') as CredentialProvider | undefined
      if (credentials === undefined) throw new Error('llm-ibm-bob: credentials service unavailable')
      await credentials.modifyRecord(CREDENTIAL_KEY, () =>
        Promise.resolve({ kind: 'grant', payload: toGrantPayload(result) }),
      )
    },
  }

  ctx.authorization.registerFlow(flow)
}
