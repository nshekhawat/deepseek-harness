/**
 * Live model catalog from the Bob Gateway `/model/info` endpoint.
 *
 * The response shape follows Bob Gateway 2.x:
 * - `data[].model_name` — the route id to register
 * - `data[].model_info.max_input_tokens` — context window
 * - `data[].model_info.max_output_tokens` — output cap (2.x); falls back to `max_tokens` (1.x)
 * - `data[].model_info.supports_vision` — image input support
 * - `data[].model_info.exposed` — when explicitly `false`, the entry is skipped
 *
 * @module @deepseek-ai/dsh-llm-ibm-bob/models
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { USER_AGENT } from './auth.ts'

/** Default context window assumed for models that report no limits. */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Default output cap assumed for models that report no limits. */
export const DEFAULT_MAX_TOKENS = 8_192

/** Discovery timeout in milliseconds. */
export const DISCOVERY_TIMEOUT_MS = 5_000

// ─── Fallback static catalog ─────────────────────────────────────────────────

/** One entry in the static fallback catalog. */
export interface BobFallbackModel {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly inputModalities: readonly ModelModality[]
}

/** Static fallback catalog used when live discovery is unavailable. */
export const FALLBACK_MODELS: readonly BobFallbackModel[] = [
  { id: 'premium-shell', name: 'Premium Shell (Sonnet 4.6)', contextWindow: 270_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'premium-ide',   name: 'Premium IDE (Sonnet 4.6)',   contextWindow: 270_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'premium',       name: 'Premium (Sonnet 4.5)',        contextWindow: 200_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'fast',          name: 'Fast',                        contextWindow: 200_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'ultra',         name: 'Ultra',                       contextWindow: 270_000, maxTokens: 128_000, inputModalities: ['text', 'image'] },
  { id: 'sonnet-4.5',    name: 'Claude Sonnet 4.5',           contextWindow: 200_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'explorer',      name: 'Explorer (Haiku 4.5)',         contextWindow: 200_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'wxO-model',     name: 'WatsonX Orchestrate Model',   contextWindow: 1_000_000, maxTokens: 64_000, inputModalities: ['text', 'image'] },
  { id: 'gpt-oss-20b',   name: 'GPT-OSS 20B',                 contextWindow: 131_072, maxTokens: 131_072, inputModalities: ['text'] },
  { id: 'granite-8b-code-instruct', name: 'Granite 8B Code Instruct', contextWindow: 128_000, maxTokens: 8_192, inputModalities: ['text'] },
  { id: 'rnj-1-test',    name: 'RNJ-1 Test',                  contextWindow: 131_072, maxTokens: 131_072, inputModalities: ['text'] },
  { id: 'rnj-1-nextedit-v1-0', name: 'RNJ-1 NextEdit',        contextWindow: 131_072, maxTokens: 131_072, inputModalities: ['text'] },
]

// ─── Discovered model ────────────────────────────────────────────────────────

/** One resolved model entry from the live catalog. */
export interface BobDiscoveredModel {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly inputModalities: readonly ModelModality[]
}

// ─── Response parsing ────────────────────────────────────────────────────────

interface RawModelInfo {
  max_input_tokens?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
  supports_vision?: unknown
  exposed?: unknown
}

interface RawModelEntry {
  model_name?: unknown
  model_info?: RawModelInfo
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function findFallback(id: string): BobFallbackModel | undefined {
  return FALLBACK_MODELS.find(m => m.id === id)
}

/**
 * Parse a raw Bob `/model/info` JSON response into a list of discovered models.
 * Entries explicitly marked `exposed: false` are excluded.
 * Entries without a usable id are skipped rather than failing the whole response.
 * @param payload - The parsed JSON from `GET /model/info`.
 * @returns Non-empty list of discovered models.
 * @throws Error when the response is not a `{ data: [...] }` object or yields no models.
 */
export function parseBobModelInfo(payload: unknown): BobDiscoveredModel[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Bob model discovery returned an invalid response.')
  }
  const data = (payload as Record<string, unknown>)['data']
  if (!Array.isArray(data)) {
    throw new Error('Bob model discovery response has no "data" array.')
  }

  const models: BobDiscoveredModel[] = []
  const seen = new Set<string>()

  for (const raw of data) {
    const entry = raw as RawModelEntry | null
    if (entry === null || typeof entry !== 'object') continue

    const id = typeof entry.model_name === 'string' ? entry.model_name.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)

    const info: RawModelInfo = (typeof entry.model_info === 'object' && entry.model_info !== null && !Array.isArray(entry.model_info))
      ? entry.model_info as RawModelInfo
      : {}

    // exposed: absent or true → include; explicit false → skip
    if (info.exposed === false) continue

    // Bob 2.x: max_output_tokens is the enforced output cap; 1.x: max_tokens
    const maxTokens = positiveInteger(
      info.max_output_tokens !== undefined ? info.max_output_tokens : info.max_tokens,
    )
    const contextWindow = positiveInteger(info.max_input_tokens)

    const fallback = findFallback(id)

    const inputModalities: readonly ModelModality[] = typeof info.supports_vision === 'boolean'
      ? (info.supports_vision ? ['text', 'image'] : ['text'])
      : (fallback?.inputModalities ?? ['text'])

    models.push({
      id,
      name: fallback?.name ?? id,
      contextWindow: contextWindow ?? fallback?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: maxTokens ?? fallback?.maxTokens ?? DEFAULT_MAX_TOKENS,
      inputModalities,
    })
  }

  if (models.length === 0) {
    throw new Error('Bob model discovery returned no usable models.')
  }
  return models
}

// ─── Live discovery ──────────────────────────────────────────────────────────

/** Headers needed to authenticate one model-info request. */
export interface ModelInfoHeaders {
  /** `Authorization: Apikey <key>` or `Authorization: Bearer <token>` */
  readonly authorization: string
  /** Required by Bob 2.x */
  readonly instanceId: string | undefined
  readonly teamId: string | undefined
}

/**
 * Fetch the live model catalog from Bob Gateway.
 *
 * Respects the caller's `signal`. Times out after `DISCOVERY_TIMEOUT_MS` when
 * no signal is given. Returns the fallback catalog on any failure so the plugin
 * can still mount.
 *
 * @param baseURL - Inference base URL (e.g. `https://api.us-east.bob.ibm.com/inference/v1`).
 * @param headers - Auth headers for the request.
 * @param signal - Optional abort signal.
 * @returns Discovered models, or the fallback catalog on error.
 */
export async function fetchBobModels(
  baseURL: string,
  headers: ModelInfoHeaders,
  signal?: AbortSignal,
): Promise<readonly BobDiscoveredModel[]> {
  const url = `${baseURL.replace(/\/+$/, '')}/model/info`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  const combined = signal !== undefined
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal

  try {
    const requestHeaders: Record<string, string> = {
      'authorization': headers.authorization,
      'user-agent': USER_AGENT,
    }
    if (headers.instanceId !== undefined) requestHeaders['x-instance-id'] = headers.instanceId
    if (headers.teamId !== undefined) requestHeaders['x-team-id'] = headers.teamId

    const response = await fetch(url, { method: 'GET', headers: requestHeaders, signal: combined })
    if (!response.ok) {
      throw new Error(`Bob model discovery request failed (HTTP ${response.status}).`)
    }
    const payload: unknown = await response.json()
    return parseBobModelInfo(payload)
  } catch {
    // Discovery failure falls back to static catalog: the plugin must mount
    // even when Bob is unreachable at startup.
    return FALLBACK_MODELS as readonly BobDiscoveredModel[]
  } finally {
    clearTimeout(timeout)
  }
}
