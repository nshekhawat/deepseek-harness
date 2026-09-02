/**
 * Configuration schema for the IBM Bob Gateway adapter.
 *
 * @module @deepseek-ai/dsh-llm-ibm-bob/config
 */

import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_AUTH_BASE_URL,
  DEFAULT_BASE_URL,
  TOKEN_REFRESH_SKEW_MS,
} from './auth.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DISCOVERY_TIMEOUT_MS,
} from './models.ts'

export { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS }

// ─── Raw config interface ────────────────────────────────────────────────────

/**
 * Plugin configuration, validated by the same-named schemastery schema.
 * All fields are optional; sensible defaults cover a standard HashiCorp
 * Bob installation.
 */
export interface Config {
  /**
   * Credential reference (env-var name) resolved per request.
   * Defaults to `BOB_API_KEY`. Used for API-key authentication.
   * Not required when using SSO (`/login ibm-bob`).
   */
  apiKeyEnv?: string

  /**
   * Bob inference base URL.
   * Defaults to `https://api.us-east.bob.ibm.com/inference/v1`.
   */
  baseURL?: string

  /**
   * Bob auth base URL for SSO token exchange and refresh.
   * Derived from `baseURL` by stripping `/inference/v1` when omitted.
   */
  authBaseURL?: string

  /**
   * Override `x-instance-id` routing header.
   * When omitted, the value from `~/.bob/settings.json` (`ibm.instanceId`) is used.
   */
  instanceId?: string

  /**
   * Override `x-team-id` routing header.
   * When omitted, the value from `~/.bob/settings.json` (`ibm.teamId`) is used.
   */
  teamId?: string

  /**
   * Discover the live model catalog from `/model/info` at startup.
   * Defaults to `true`. Falls back to the static catalog on failure.
   */
  discoverModels?: boolean

  /**
   * Discovery timeout in milliseconds. Defaults to 5 000.
   * Startup continues with the fallback catalog when this expires.
   */
  discoveryTimeoutMs?: number

  /**
   * Default context window for models that report no limits.
   * Defaults to 200 000.
   */
  defaultContextWindow?: number

  /**
   * Default output cap for models that report no limits.
   * Defaults to 8 192.
   */
  defaultMaxTokens?: number

  /**
   * Maximum idle interval while a stream read is outstanding (ms).
   * Defaults to 300 000 (five minutes).
   */
  streamIdleTimeoutMs?: number

  /** Provider-owned model-request retry policy. Defaults to five retries. */
  retryPolicy?: RetryPolicyConfig
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_API_KEY_ENV = 'BOB_API_KEY'

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  authBaseURL: z.string(),
  instanceId: z.string(),
  teamId: z.string(),
  discoverModels: z.boolean().default(true),
  discoveryTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DISCOVERY_TIMEOUT_MS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

// ─── Resolved options ────────────────────────────────────────────────────────

/** Validated, fully-resolved connection facts for one request or startup operation. */
export interface ResolvedBobOptions {
  /** Resolved credential reference. Always set; used for API-key auth. */
  readonly apiKeyEnv: CredentialRef
  /** Inference base URL, without trailing slash. */
  readonly baseURL: string
  /** Auth base URL for token exchange and refresh. */
  readonly authBaseURL: string
  /** Override `x-instance-id` header, or `undefined` to use Bob Shell settings. */
  readonly instanceId: string | undefined
  /** Override `x-team-id` header, or `undefined` to use Bob Shell settings. */
  readonly teamId: string | undefined
  /** Whether to run live model discovery at startup. */
  readonly discoverModels: boolean
  /** Discovery timeout in milliseconds. */
  readonly discoveryTimeoutMs: number
  /** Default context window for models reporting no limit. */
  readonly defaultContextWindow: number
  /** Default output cap for models reporting no limit. */
  readonly defaultMaxTokens: number
  /** Max idle interval while a stream read is outstanding (ms). */
  readonly streamIdleTimeoutMs: number
  /** Resolved retry policy. */
  readonly retryPolicy: ResolvedRetryPolicy
}

/**
 * Derive the auth base URL from the inference base URL by stripping the
 * `/inference/v1` suffix, mirroring how the opencode plugin does it.
 */
function deriveAuthBaseURL(inferenceBaseURL: string): string {
  const suffix = '/inference/v1'
  const normalized = inferenceBaseURL.replace(/\/+$/, '')
  return normalized.endsWith(suffix)
    ? normalized.slice(0, -suffix.length)
    : normalized
}

/**
 * Validate raw config and produce resolved facts.
 * Throws with a descriptive message for any invalid field.
 */
export function resolveOptions(config: Config): ResolvedBobOptions {
  const baseURL = (config.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  if (baseURL.length === 0) throw new Error('llm-ibm-bob: baseURL must not be empty')

  const authBaseURL = (config.authBaseURL ?? deriveAuthBaseURL(baseURL)).replace(/\/+$/, '')
  if (authBaseURL.length === 0) throw new Error('llm-ibm-bob: authBaseURL must not be empty')

  // Validate TOKEN_REFRESH_SKEW_MS < discoveryTimeoutMs is not required —
  // they are independent knobs — but streamIdleTimeoutMs must be finite and positive.
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-ibm-bob: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }

  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-ibm-bob: defaultContextWindow must be a positive integer')
  }

  const defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
  if (!Number.isInteger(defaultMaxTokens) || defaultMaxTokens <= 0) {
    throw new Error('llm-ibm-bob: defaultMaxTokens must be a positive integer')
  }

  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL,
    authBaseURL,
    instanceId: config.instanceId?.trim() || undefined,
    teamId: config.teamId?.trim() || undefined,
    discoverModels: config.discoverModels ?? true,
    discoveryTimeoutMs: config.discoveryTimeoutMs ?? DISCOVERY_TIMEOUT_MS,
    defaultContextWindow,
    defaultMaxTokens,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-ibm-bob: retryPolicy'),
  }
}

// ─── Re-export for external consumers ────────────────────────────────────────

export { TOKEN_REFRESH_SKEW_MS, DEFAULT_BASE_URL, DEFAULT_AUTH_BASE_URL }
