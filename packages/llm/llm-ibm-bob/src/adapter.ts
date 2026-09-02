/**
 * IBM Bob Gateway LLM adapter.
 *
 * Posts to `<baseURL>/chat/completions` using the OpenAI Chat Completions
 * wire format and SSE streaming. Authentication is:
 * - API key: `Authorization: Apikey <key>`
 * - OAuth SSO: `Authorization: Bearer <access-token>` (with proactive refresh)
 *
 * Per-request Bob routing headers (`x-instance-id`, `x-team-id`) come from:
 * 1. Plugin config (`instanceId` / `teamId`)
 * 2. `~/.bob/settings.json` (`ibm.instanceId` / `ibm.teamId`)
 *
 * @module @deepseek-ai/dsh-llm-ibm-bob/adapter
 */

import {
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedBobOptions } from './config.ts'
import type { BobDiscoveredModel } from './models.ts'
import {
  readBobShellSelector,
  USER_AGENT,
  refreshAccessToken,
  isExpired,
} from './auth.ts'
import type { BobGrantPayload } from './auth.ts'

// ─── Constructor options ──────────────────────────────────────────────────────

/** Injected by the plugin; resolved once per stream call. */
export interface BobAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  readonly options: () => ResolvedBobOptions
  /** Current live model catalog. */
  readonly models: () => readonly BobDiscoveredModel[]
  /**
   * Resolve the API key for API-key auth.
   * Returns `undefined` when SSO should be used instead.
   * Throws `LlmError` `MISSING_CREDENTIAL` when no credential is available.
   */
  readonly resolveApiKey: (ref: CredentialRef) => Promise<string | undefined>
  /**
   * Read the current stored OAuth grant, if any.
   * Called per request to check whether SSO credentials exist.
   */
  readonly readGrant: () => Promise<BobGrantPayload | undefined>
  /**
   * Persist a refreshed OAuth grant so the next request uses the new token
   * without going through the login flow again.
   */
  readonly writeGrant: (payload: BobGrantPayload) => Promise<void>
}

// ─── Wire types ───────────────────────────────────────────────────────────────

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | WireContentPart[] | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  name?: string
}

interface WireContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireTool {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options?: { include_usage?: boolean }
  tools?: WireTool[]
  max_tokens: number
}

interface WireDelta {
  role?: string
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: { name?: string; arguments?: string }
  }>
}

interface WireChoice {
  index: number
  delta: WireDelta
  finish_reason?: string | null
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage
  error?: { message?: string; code?: string }
}

interface WireError {
  error?: { message?: string; code?: string; type?: string }
}

// ─── Serialization ────────────────────────────────────────────────────────────

function contentToWire(content: readonly ContentBlock[]): string | WireContentPart[] {
  const parts: WireContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: (block as TextBlock).text })
    }
    // image and other modalities are skipped at this layer; a full
    // implementation would resolve attachments here (see dsh-llm-deepseek).
  }
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text ?? ''
  }
  return parts
}

function toolResultContent(block: ToolResultBlock): string {
  return block.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
}

function serializeMessages(options: GenerateOptions): WireMessage[] {
  const messages: WireMessage[] = []

  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }

  for (const msg of options.messages) {
    if (msg.role === 'user') {
      // A user message may contain tool-result blocks (tool call responses).
      const hasToolResults = msg.content.some(b => b.type === 'tool-result')
      if (hasToolResults) {
        for (const block of msg.content) {
          if (block.type === 'tool-result') {
            const tb = block as ToolResultBlock
            messages.push({
              role: 'tool',
              tool_call_id: String(tb.toolCallId),
              content: toolResultContent(tb),
            })
          }
        }
      } else {
        messages.push({ role: 'user', content: contentToWire(msg.content) })
      }
    } else if (msg.role === 'assistant') {
      const toolCalls = msg.content
        .filter((b): b is ToolCallBlock => b.type === 'tool-call')
        .map(b => ({
          id: String(b.id),
          type: 'function' as const,
          function: { name: b.name, arguments: b.arguments },
        }))
      const textContent = msg.content
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
      messages.push({
        role: 'assistant',
        content: textContent || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
    }
  }
  return messages
}

function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: t.parameters as Record<string, unknown>,
    },
  }))
}

function buildWireRequest(options: GenerateOptions, conn: ResolvedBobOptions): WireRequest {
  const tools = serializeTools(options.tools)
  return {
    model: options.model,
    messages: serializeMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? conn.defaultMaxTokens,
    ...(tools !== undefined ? { tools } : {}),
  }
}

// ─── SSE parsing ─────────────────────────────────────────────────────────────

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
): AsyncIterable<WireChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as WireChunk
        } catch { /* skip malformed chunk */ }
      }
    }
  } finally {
    await reader.cancel().catch(() => { /* best-effort */ })
  }
}

// ─── Stream translation ───────────────────────────────────────────────────────

function mapFinishReason(raw: string | null | undefined): FinishReason | undefined {
  if (raw === 'stop') return { kind: 'stop' }
  if (raw === 'tool_calls') return { kind: 'tool-calls' }
  if (raw === 'length') return { kind: 'max-tokens' }
  return undefined
}

async function* translateChunks(
  chunks: AsyncIterable<WireChunk>,
): AsyncIterable<StreamChunk> {
  let textBlock: { index: number; text: string } | undefined
  let nextIndex = 0
  const toolCalls: Map<number, { index: number; id: string; name: string; args: string }> = new Map()
  let pendingFinish: import('@deepseek-ai/dsh-llm').FinishReason | undefined
  let pendingUsage: { inputTokens: number; outputTokens: number } | undefined

  for await (const chunk of chunks) {
    if (chunk.error !== undefined) {
      throw new LlmError(chunk.error.message ?? 'Bob API stream error', 'SERVER')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (textBlock === undefined) {
          textBlock = { index: nextIndex++, text: '' }
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += delta.content
        yield { type: 'text-delta', index: textBlock.index, text: delta.content }
      }

      for (const tc of delta.tool_calls ?? []) {
        let entry = toolCalls.get(tc.index)
        if (entry === undefined) {
          entry = { index: nextIndex++, id: tc.id ?? '', name: tc.function?.name ?? '', args: '' }
          toolCalls.set(tc.index, entry)
          yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
        }
        if (tc.id) entry.id = tc.id
        if (tc.function?.name) entry.name = tc.function.name
        const fragment = tc.function?.arguments ?? ''
        entry.args += fragment
        yield {
          type: 'tool-call-delta',
          index: entry.index,
          id: entry.id as import('@deepseek-ai/dsh-llm').ToolCallId,
          name: entry.name,
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    if (chunk.usage !== undefined) {
      pendingUsage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      }
    }
  }

  // Emit block-ends, usage, and finish after the stream closes.
  if (textBlock !== undefined) {
    yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
  }
  for (const [, tc] of toolCalls) {
    yield {
      type: 'block-end',
      index: tc.index,
      block: { type: 'tool-call', id: tc.id as import('@deepseek-ai/dsh-llm').ToolCallId, name: tc.name, arguments: tc.args },
    }
  }
  if (pendingUsage !== undefined) {
    yield { type: 'usage', usage: pendingUsage }
  }
  yield { type: 'finish', reason: pendingFinish ?? { kind: 'stop' } }
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

const STREAM_IDLE_TIMEOUT_CODE = 'BOB_STREAM_IDLE_TIMEOUT'

/** Routing headers for one request, resolved from config or Bob Shell settings. */
interface RoutingHeaders {
  instanceId: string | undefined
  teamId: string | undefined
}

function resolveRoutingHeaders(conn: ResolvedBobOptions): RoutingHeaders {
  if (conn.instanceId !== undefined || conn.teamId !== undefined) {
    return { instanceId: conn.instanceId, teamId: conn.teamId }
  }
  // Fall back to ~/.bob/settings.json
  const shell = readBobShellSelector()
  return { instanceId: shell.instanceId, teamId: shell.teamId }
}

// ─── Adapter class ────────────────────────────────────────────────────────────

export class BobAdapter extends LlmAdapter {
  constructor(private readonly config: BobAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'IBM Bob Gateway' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(
      this.config.models().map(m => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: [...m.inputModalities] as import('@deepseek-ai/dsh-llm').ModelModality[],
      })),
    )
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.modelInfoFor(provider, model))
  }

  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    return Promise.resolve({
      model: this.modelInfoFor(provider, model),
      stream: options => this.streamWithConnection(options),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options)
  }

  private modelInfoFor(provider: string, model: string): LlmResolvedModelInfo {
    const conn = this.config.options()
    const found = this.config.models().find(m => m.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      inputModalities: found !== undefined
        ? [...found.inputModalities] as import('@deepseek-ai/dsh-llm').ModelModality[]
        : ['text' as const],
      context: { contextWindow: found?.contextWindow ?? conn.defaultContextWindow },
      defaultMaxTokens: found?.maxTokens ?? conn.defaultMaxTokens,
    }
  }

  private async * streamWithConnection(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const conn = this.config.options()

    // Resolve auth: SSO grant takes precedence over API key.
    let authorization: string
    let grant = await this.config.readGrant()

    if (grant !== undefined) {
      // Proactively refresh before the token expires.
      if (isExpired(grant)) {
        const result = await refreshAccessToken(conn.authBaseURL, grant.refresh)
        if (result.type === 'success') {
          grant = { type: 'oauth', access: result.access, refresh: result.refresh, expires: result.expires }
          await this.config.writeGrant(grant)
        } else {
          throw new LlmError(
            'IBM Bob OAuth token refresh failed. Run the login flow again.',
            'AUTH',
          )
        }
      }
      authorization = `Bearer ${grant.access}`
    } else {
      // Fall back to API key.
      const rawKey = await this.config.resolveApiKey(conn.apiKeyEnv)
      if (rawKey === undefined) {
        throw new LlmError(
          `llm-ibm-bob: no credential available for IBM Bob. Export ${String(conn.apiKeyEnv)} or run the login flow.`,
          'MISSING_CREDENTIAL',
        )
      }
      authorization = `Apikey ${rawKey}`
    }

    const routing = resolveRoutingHeaders(conn)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])

    using watchdog = idleWatchdog(upstream, conn.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, conn, authorization, routing, watchdog.signal, () => {
      watchdog.pulse()
    })[Symbol.asyncIterator]()

    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) { exhausted = true; break }
        yield result.value
      }
    } catch (err: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `IBM Bob stream idle timeout after ${conn.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: err },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('IBM Bob request aborted by caller', 'ABORTED', { cause: err })
      }
      if (err instanceof LlmError) throw err
      throw new LlmError(`IBM Bob stream from ${conn.baseURL} failed`, 'TRANSPORT', { cause: err })
    } finally {
      consumer.abort('IBM Bob stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        await iterator.return().catch(() => { /* teardown */ })
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    conn: ResolvedBobOptions,
    authorization: string,
    routing: RoutingHeaders,
    signal: AbortSignal,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers: Record<string, string> = {
      'authorization': authorization,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': USER_AGENT,
      // attributionHeaders() would overwrite the Bob Shell UA that Cloudflare requires.
    }
    if (routing.instanceId !== undefined) headers['x-instance-id'] = routing.instanceId
    if (routing.teamId !== undefined) headers['x-team-id'] = routing.teamId

    const body = JSON.stringify(buildWireRequest(options, conn))

    let response: Response
    try {
      response = await fetch(`${conn.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal,
      })
    } catch (err: unknown) {
      if (signal.aborted) throw err
      throw new LlmError(`IBM Bob request to ${conn.baseURL} failed`, 'TRANSPORT', { cause: err })
    }

    if (!response.ok) {
      const rawBody = await response.text().catch(() => '')
      // Cloudflare blocks return HTML — detect and surface a clear message.
      if (rawBody.trimStart().startsWith('<')) {
        throw new LlmError(
          `IBM Bob request blocked by Cloudflare (HTTP ${response.status}). Check your network or VPN.`,
          response.status === 401 || response.status === 403 ? 'AUTH' : 'SERVER',
          { status: response.status },
        )
      }
      let errorMessage = `IBM Bob API error (HTTP ${response.status})`
      try {
        const parsed = JSON.parse(rawBody) as WireError
        if (parsed.error?.message) errorMessage = parsed.error.message
      } catch { /* keep the generic message */ }

      const code = response.status === 401 || response.status === 403
        ? 'AUTH'
        : response.status === 429
          ? 'RATE_LIMIT'
          : response.status >= 500
            ? 'SERVER'
            : 'INVALID_REQUEST'
      throw new LlmError(errorMessage, code, { status: response.status })
    }

    if (response.body === null) {
      throw new LlmError('IBM Bob API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translateChunks(parseSse(response.body, onActivity))
  }
}
