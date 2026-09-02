# dsh-llm-ibm-bob

DeepSeek Harness LLM 接缝的 IBM Bob Gateway 适配器。

注册 `ibm-bob` 供应商路由，使用 OpenAI 兼容的聊天完成接口。
支持 API 密钥和 IBM OAuth SSO（IBMid）身份验证，
并从 Bob Gateway 的 `/model/info` 端点实时发现模型目录。

## 身份验证

**API 密钥** — 导出 `BOB_API_KEY` 或配置 `apiKeyEnv`：

```bash
export BOB_API_KEY=sk-...
```

**IBMid SSO** — 从交互式会话触发登录流程。当 `ctx.authz` 存在时，
插件会在其下注册 OAuth 流程。令牌存储在 harness 凭据存储中并自动刷新。

## 配置

```yaml
- id: llm-ibm-bob
  name: '@deepseek-ai/dsh-llm-ibm-bob'
  config:
    # apiKeyEnv: BOB_API_KEY
    # baseURL: https://api.us-east.bob.ibm.com/inference/v1
    # authBaseURL: https://api.us-east.bob.ibm.com
    # instanceId: your-instance-id
    # teamId: your-team-id
    # discoverModels: true
```

详细说明请参阅 [README.md](./README.md)。
