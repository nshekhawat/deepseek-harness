/**
 * IBM Bob Gateway LLM adapter plugin for DeepSeek Harness.
 *
 * Registers the `ibm-bob` provider route on `ctx.llm` using an OpenAI-compatible
 * chat-completions transport. Supports both API-key and IBM OAuth SSO authentication.
 *
 * ## Minimal cordis.yml entry (API key)
 *
 * ```yaml
 * - id: llm-ibm-bob
 *   name: '@deepseek-ai/dsh-llm-ibm-bob'
 *   # apiKeyEnv defaults to BOB_API_KEY; export it or configure it below.
 * ```
 *
 * ## With explicit config
 *
 * ```yaml
 * - id: llm-ibm-bob
 *   name: '@deepseek-ai/dsh-llm-ibm-bob'
 *   config:
 *     apiKeyEnv: BOB_API_KEY
 *     baseURL: https://api.us-east.bob.ibm.com/inference/v1
 *     instanceId: your-instance-id   # or omit to read from ~/.bob/settings.json
 *     teamId: your-team-id
 *     discoverModels: true
 * ```
 *
 * ## SSO login
 *
 * When `ctx.authz` is present (interactive sessions), the plugin registers an
 * IBMid OAuth login flow. Trigger it from the UI or CLI with the provider key
 * `llm-ibm-bob/ibm-bob`.
 *
 * @module @deepseek-ai/dsh-llm-ibm-bob
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  assertUsableApiKey,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import {
  AuthorizationDeclinedError,
  AuthorizationError,
} from '@deepseek-ai/dsh-authorization'
import type { AuthorizationInteraction, AuthorizationNotice, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import { Config, resolveOptions } from './config.ts'
import type { ResolvedBobOptions } from './config.ts'
import {
  CREDENTIAL_KEY,
  PROVIDER,
  isExpired,
} from './auth.ts'
import type { BobGrantPayload } from './auth.ts'
import { fetchBobModels, FALLBACK_MODELS } from './models.ts'
import type { BobDiscoveredModel } from './models.ts'
import { BobAdapter } from './adapter.ts'
import { registerBobLoginFlow } from './login.ts'

export { Config } from './config.ts'
export type { ResolvedBobOptions } from './config.ts'
export { BobAdapter } from './adapter.ts'
export type { BobAdapterOptions } from './adapter.ts'
export { CREDENTIAL_KEY, PROVIDER } from './auth.ts'
export type { BobGrantPayload, BobShellSelector } from './auth.ts'
export { parseBobModelInfo, FALLBACK_MODELS } from './models.ts'
export type { BobDiscoveredModel, BobFallbackModel } from './models.ts'

/** Cordis plugin name. */
export const name = 'llm-ibm-bob'

/** Seam injections required at mount time. */
export const inject = ['llm'] as const

const NS = 'llm-ibm-bob'

// ─── Plugin apply ─────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedBobOptions | undefined

  const options = (): ResolvedBobOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-ibm-bob: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  // ── Credential helpers ───────────────────────────────────────────────────

  const resolveApiKey = async (ref: import('@deepseek-ai/dsh-credentials').CredentialRef): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && hit.value.length > 0) {
        return assertUsableApiKey(hit.value, 'llm-ibm-bob', ref)
      }
    } else {
      const ambient = launchEnvironmentOf(ctx).get(String(ref))
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-ibm-bob', ref)
      }
    }
    return undefined
  }

  const readGrant = async (): Promise<BobGrantPayload | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    const record = await credentials.readRecord(CREDENTIAL_KEY)
    if (record === undefined || record.kind !== 'grant') return undefined
    const payload = record.payload as BobGrantPayload
    if (payload.type !== 'oauth' || typeof payload.access !== 'string') return undefined
    return payload
  }

  const writeGrant = async (payload: BobGrantPayload): Promise<void> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return
    await credentials.modifyRecord(CREDENTIAL_KEY, () =>
      Promise.resolve({ kind: 'grant', payload }),
    )
  }

  // ── Live model catalog ───────────────────────────────────────────────────

  let liveModels: readonly BobDiscoveredModel[] = [...FALLBACK_MODELS]

  const refreshCatalog = async (): Promise<void> => {
    const conn = options()
    if (!conn.discoverModels) return

    // Build auth headers for the model-info request.
    // Try SSO grant first, then API key.
    let authorization: string | undefined

    const grant = await readGrant()
    if (grant !== undefined && !isExpired(grant)) {
      authorization = `Bearer ${grant.access}`
    } else {
      const key = await resolveApiKey(conn.apiKeyEnv)
      if (key !== undefined) authorization = `Apikey ${key}`
    }

    if (authorization === undefined) {
      ctx.logger.debug('llm-ibm-bob: skipping model discovery — no credentials available yet')
      return
    }

    const routing = {
      authorization,
      instanceId: conn.instanceId,
      teamId: conn.teamId,
    }
    const discovered = await fetchBobModels(conn.baseURL, routing)
    liveModels = discovered
    ctx.logger.debug('llm-ibm-bob: discovered %d models from Bob Gateway', discovered.length)
  }

  // Fire-and-forget on mount; failures are already swallowed inside fetchBobModels.
  void refreshCatalog()

  // ── Adapter ──────────────────────────────────────────────────────────────

  const adapter = new BobAdapter({
    options,
    models: () => liveModels,
    resolveApiKey,
    readGrant,
    writeGrant,
  })

  // ── Registration ─────────────────────────────────────────────────────────

  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'IBM Bob Gateway', settingsNs: NS, settingsPath: [] },
  ])

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy

  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // ── SSO login flow + /login command (interactive only) ──────────────────

  ctx.inject(['authorization'], (authCtx) => {
    registerBobLoginFlow(authCtx, () => options().authBaseURL)

    // After a successful login, refresh the model catalog with the new token.
    authCtx.on('authorization/settled', (key: import('@deepseek-ai/dsh-credentials').CredentialKey, settlement: import('@deepseek-ai/dsh-authorization').AuthorizationSettlement) => {
      if (key !== CREDENTIAL_KEY || settlement !== 'authorized') return
      void refreshCatalog()
    })

    // Register /login so the user can trigger OAuth from the chat composer.
    authCtx.inject(['commands'], (cmdCtx) => {
      cmdCtx.effect(function* () {
        yield cmdCtx.commands.register({
          name: 'login',
          description: 'Sign in to IBM Bob Gateway via IBMid OAuth',
          async handler(invocation: CommandInvocation): Promise<CommandResult> {
            const arg = invocation.rawInput.trim()
            const method = arg.length > 0 ? arg : 'oauth-auto'

            // Build an interaction surface backed by the session's question channel.
            const interaction: AuthorizationInteraction = {
              notify(notice: AuthorizationNotice): void {
                const parts = [notice.message]
                if (notice.url !== undefined) parts.push(`URL: ${notice.url}`)
                if (notice.code !== undefined) parts.push(`Code: ${notice.code}`)
                ctx.logger.info('llm-ibm-bob: %s', parts.join(' — '))
              },
              async prompt(prompt: AuthorizationPrompt): Promise<string> {
                if (prompt.signal?.aborted === true) {
                  throw new AuthorizationDeclinedError()
                }
                const questions = cmdCtx.get('userQuestions')
                if (questions === undefined) {
                  throw new AuthorizationDeclinedError()
                }
                const kind = prompt.kind
                const answer = await questions.ask({
                  agent: invocation.agent,
                  signal: invocation.signal,
                  questions: [{
                    id: 'code',
                    question: prompt.message,
                    options: kind === 'select'
                      ? prompt.options.map(o => ({ label: o.label }))
                      : [],
                  }],
                })
                const item = answer.answers[0]
                if (item === undefined) throw new AuthorizationDeclinedError()
                if (kind === 'select') {
                  const chosen = prompt.options.find(o => o.label === item.selected[0])
                  if (chosen === undefined) throw new AuthorizationDeclinedError()
                  return chosen.id
                }
                return item.custom ?? item.selected[0] ?? ''
              },
            }

            try {
              const outcome = await authCtx.authorization.begin({
                key: CREDENTIAL_KEY,
                method,
                signal: invocation.signal,
                interaction,
              })
              return outcome.status === 'authorized'
                ? { kind: 'success', text: 'Signed in to IBM Bob Gateway.' }
                : { kind: 'error', text: 'Sign-in cancelled.' }
            } catch (error) {
              if (error instanceof AuthorizationDeclinedError) {
                return { kind: 'error', text: 'Sign-in declined.' }
              }
              if (error instanceof AuthorizationError) {
                return { kind: 'error', text: `Sign-in failed: ${error.message}` }
              }
              throw error
            }
          },
        })
      }, 'llm-ibm-bob /login command')
    })
  })

  // ── Settings integration ─────────────────────────────────────────────────

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (src) => { current = src },
      onChange: () => {
        try {
          ensureRegistrationFacts()
        } catch (err) {
          ctx.logger.error('llm-ibm-bob: keeping previously registered route after a refused update')
          ctx.logger.error(err)
        }
        // Re-discover models when the config changes (e.g. new baseURL or credentials).
        void refreshCatalog()
      },
    })
  })
}
