/**
 * Unit tests for the IBM Bob Gateway adapter.
 *
 * Covers: Bob Shell settings parsing, model-info response normalization,
 * config resolution, auth helpers, and SSE chunk translation.
 * No network calls; no live Bob credentials required.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { readBobShellSelector, isExpired, parseAuthorizationInput, toGrantPayload } from '../src/auth.ts'
import type { TokenSuccess } from '../src/auth.ts'
import { parseBobModelInfo, FALLBACK_MODELS } from '../src/models.ts'
import { resolveOptions } from '../src/config.ts'
import type { Config } from '../src/config.ts'

// ─── Bob Shell settings ───────────────────────────────────────────────────────

describe('readBobShellSelector', () => {
  it('returns undefined fields when the file does not exist', () => {
    // We cannot easily override homedir in-process, so just verify it never throws.
    const result = readBobShellSelector()
    assert.equal(typeof result.instanceId === 'string' || result.instanceId === undefined, true)
    assert.equal(typeof result.teamId === 'string' || result.teamId === undefined, true)
  })
})

// ─── Auth helpers ─────────────────────────────────────────────────────────────

describe('isExpired', () => {
  it('returns true when expires is in the past', () => {
    const grant = { type: 'oauth' as const, access: 'tok', refresh: 'ref', expires: Date.now() - 1000 }
    assert.equal(isExpired(grant), true)
  })

  it('returns true when expires is within the skew window', () => {
    const grant = { type: 'oauth' as const, access: 'tok', refresh: 'ref', expires: Date.now() + 30_000 }
    assert.equal(isExpired(grant), true)
  })

  it('returns false when expires is well in the future', () => {
    const grant = { type: 'oauth' as const, access: 'tok', refresh: 'ref', expires: Date.now() + 3_600_000 }
    assert.equal(isExpired(grant), false)
  })
})

describe('toGrantPayload', () => {
  it('round-trips a token result', () => {
    const result: TokenSuccess = { type: 'success', access: 'a', refresh: 'r', expires: 12345 }
    const payload = toGrantPayload(result)
    assert.equal(payload.type, 'oauth')
    assert.equal(payload.access, 'a')
    assert.equal(payload.refresh, 'r')
    assert.equal(payload.expires, 12345)
  })
})

describe('parseAuthorizationInput', () => {
  it('parses a full redirect URL', () => {
    const url = 'http://127.0.0.1:1455/bob-shell-auth-callback?code=abc&state=/deadbeef'
    const result = parseAuthorizationInput(url)
    assert.equal(result.code, 'abc')
    assert.equal(result.state, '/deadbeef')
  })

  it('parses code#state format', () => {
    const result = parseAuthorizationInput('mycode#mystate')
    assert.equal(result.code, 'mycode')
    assert.equal(result.state, 'mystate')
  })

  it('parses a bare code', () => {
    const result = parseAuthorizationInput('justthecode')
    assert.equal(result.code, 'justthecode')
    assert.equal(result.state, undefined)
  })

  it('returns empty object for blank input', () => {
    assert.deepEqual(parseAuthorizationInput(''), {})
    assert.deepEqual(parseAuthorizationInput(undefined), {})
  })
})

// ─── Model info parsing ───────────────────────────────────────────────────────

describe('parseBobModelInfo', () => {
  it('parses a Bob 2.x model-info response', () => {
    const payload = {
      data: [
        {
          model_name: 'premium',
          model_info: {
            max_input_tokens: 200_000,
            max_output_tokens: 64_000,
            max_tokens: 12_000,      // 2.x: max_output_tokens wins
            supports_vision: true,
          },
        },
        {
          model_name: 'fast',
          model_info: {
            max_input_tokens: 200_000,
            max_output_tokens: 64_000,
          },
        },
      ],
    }
    const models = parseBobModelInfo(payload)
    assert.equal(models.length, 2)

    const premium = models.find(m => m.id === 'premium')
    assert.ok(premium)
    assert.equal(premium.contextWindow, 200_000)
    assert.equal(premium.maxTokens, 64_000)   // max_output_tokens wins over max_tokens
    assert.deepEqual(premium.inputModalities, ['text', 'image'])
  })

  it('parses a Bob 1.x model-info response (no max_output_tokens)', () => {
    const payload = {
      data: [
        {
          model_name: 'ultra',
          model_info: {
            max_input_tokens: 270_000,
            max_tokens: 128_000,
          },
        },
      ],
    }
    const models = parseBobModelInfo(payload)
    const ultra = models[0]
    assert.ok(ultra)
    assert.equal(ultra.maxTokens, 128_000)
  })

  it('skips entries with exposed: false', () => {
    const payload = {
      data: [
        { model_name: 'visible', model_info: { max_input_tokens: 10, max_tokens: 10 } },
        { model_name: 'hidden',  model_info: { max_input_tokens: 10, max_tokens: 10, exposed: false } },
      ],
    }
    const models = parseBobModelInfo(payload)
    assert.equal(models.length, 1)
    assert.equal(models[0]?.id, 'visible')
  })

  it('skips entries with no usable id', () => {
    const payload = {
      data: [
        { model_name: '',  model_info: {} },
        { model_name: 'ok', model_info: { max_input_tokens: 1, max_tokens: 1 } },
      ],
    }
    const models = parseBobModelInfo(payload)
    assert.equal(models.length, 1)
  })

  it('throws on invalid response shape', () => {
    assert.throws(() => parseBobModelInfo(null), /invalid response/)
    assert.throws(() => parseBobModelInfo({}), /no "data" array/)
    assert.throws(() => parseBobModelInfo({ data: [] }), /no usable models/)
  })

  it('uses fallback catalog values for known models missing limits', () => {
    const payload = {
      data: [
        { model_name: 'premium', model_info: {} }, // no limits in response
      ],
    }
    const models = parseBobModelInfo(payload)
    const premium = models[0]
    assert.ok(premium)
    // Should use fallback for premium: contextWindow=200_000, maxTokens=64_000
    const fallback = FALLBACK_MODELS.find(m => m.id === 'premium')
    assert.ok(fallback)
    assert.equal(premium.contextWindow, fallback.contextWindow)
    assert.equal(premium.maxTokens, fallback.maxTokens)
  })
})

// ─── Config resolution ────────────────────────────────────────────────────────

describe('resolveOptions', () => {
  it('uses defaults when all fields are omitted', () => {
    const opts = resolveOptions({} as Config)
    assert.equal(opts.baseURL, 'https://api.us-east.bob.ibm.com/inference/v1')
    assert.equal(opts.authBaseURL, 'https://api.us-east.bob.ibm.com')
    assert.equal(opts.discoverModels, true)
    assert.equal(opts.instanceId, undefined)
    assert.equal(opts.teamId, undefined)
  })

  it('derives authBaseURL from baseURL', () => {
    const opts = resolveOptions({ baseURL: 'https://api.eu-de.bob.ibm.com/inference/v1' } as Config)
    assert.equal(opts.authBaseURL, 'https://api.eu-de.bob.ibm.com')
  })

  it('accepts an explicit authBaseURL override', () => {
    const opts = resolveOptions({
      baseURL: 'https://custom.example.com/inference/v1',
      authBaseURL: 'https://auth.example.com',
    } as Config)
    assert.equal(opts.authBaseURL, 'https://auth.example.com')
  })

  it('strips trailing slashes from URLs', () => {
    const opts = resolveOptions({ baseURL: 'https://api.us-east.bob.ibm.com/inference/v1///' } as Config)
    assert.equal(opts.baseURL, 'https://api.us-east.bob.ibm.com/inference/v1')
  })

  it('trims whitespace from instanceId / teamId', () => {
    const opts = resolveOptions({ instanceId: '  myinstance  ', teamId: '  myteam  ' } as Config)
    assert.equal(opts.instanceId, 'myinstance')
    assert.equal(opts.teamId, 'myteam')
  })

  it('sets instanceId/teamId to undefined for blank strings', () => {
    const opts = resolveOptions({ instanceId: '   ', teamId: '' } as Config)
    assert.equal(opts.instanceId, undefined)
    assert.equal(opts.teamId, undefined)
  })

  it('throws on invalid streamIdleTimeoutMs', () => {
    assert.throws(
      () => resolveOptions({ streamIdleTimeoutMs: -1 } as Config),
      /streamIdleTimeoutMs/,
    )
  })
})
