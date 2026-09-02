# dsh-llm-ibm-bob

IBM Bob Gateway adapter for the DeepSeek Harness LLM seam.

Registers the `ibm-bob` provider route using OpenAI-compatible chat completions.
Supports both API-key and IBM OAuth SSO (IBMid) authentication, with live model
catalog discovery from Bob Gateway's `/model/info` endpoint.

## Authentication

**API key** — export `BOB_API_KEY` or configure `apiKeyEnv`:

```bash
export BOB_API_KEY=sk-...
```

**IBMid SSO** — trigger the login flow from an interactive session. The plugin
registers an OAuth flow under `ctx.authz` when that seam is present. Tokens are
stored in the harness credential store and refreshed automatically.

## Configuration

```yaml
- id: llm-ibm-bob
  name: '@deepseek-ai/dsh-llm-ibm-bob'
  config:
    # apiKeyEnv: BOB_API_KEY          # env-var name for the API key (default)
    # baseURL: https://api.us-east.bob.ibm.com/inference/v1
    # authBaseURL: https://api.us-east.bob.ibm.com   # derived from baseURL when omitted
    # instanceId: your-instance-id    # or omit to read from ~/.bob/settings.json
    # teamId: your-team-id
    # discoverModels: true            # fetch live catalog from /model/info
    # discoveryTimeoutMs: 5000
    # defaultContextWindow: 200000
    # defaultMaxTokens: 8192
    # streamIdleTimeoutMs: 300000
```

### Routing headers

`x-instance-id` and `x-team-id` are resolved in this order:

1. `instanceId` / `teamId` in the plugin config.
2. `ibm.instanceId` / `ibm.teamId` from `~/.bob/settings.json` (Bob Shell 1.x format).
3. Header omitted.

## Model discovery

When `discoverModels: true` (the default), the plugin fetches
`GET /model/info` at startup and after every successful SSO login.
The live catalog updates the context window, output cap, and vision support
for each model from Bob's own metadata. The static fallback catalog covers
`premium`, `fast`, `ultra`, `premium-shell`, `premium-ide`, `sonnet-4.5`,
`explorer`, `wxO-model`, `gpt-oss-20b`, and Granite/RNJ models.

Bob 2.x returns `max_output_tokens` as the enforced output cap; 1.x returns
`max_tokens`. The adapter uses `max_output_tokens` when present and falls
back to `max_tokens`.

## Fallback models

| ID | Name | Context | Output |
|----|------|---------|--------|
| `premium` | Premium (Sonnet 4.5) | 200k | 64k |
| `premium-shell` | Premium Shell (Sonnet 4.6) | 270k | 64k |
| `premium-ide` | Premium IDE (Sonnet 4.6) | 270k | 64k |
| `fast` | Fast | 200k | 64k |
| `ultra` | Ultra | 270k | 128k |
| `wxO-model` | WatsonX Orchestrate Model | 1M | 64k |
| `gpt-oss-20b` | GPT-OSS 20B | 131k | 131k |
