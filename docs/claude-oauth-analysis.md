# Claude OAuth 认证实现分析

> 分析 third_party 目录下三个仓库 (OmniRoute、openclaw-billing-proxy、sub2api) 的 Claude OAuth 实现方式

---

## 目录

- [1. OmniRoute](#1-omniroute)
- [2. openclaw-billing-proxy](#2-openclaw-billing-proxy)
- [3. sub2api](#3-sub2api)
- [4. 三种实现对比汇总](#4-三种实现对比汇总)

---

## 1. OmniRoute

**技术栈**: TypeScript / Next.js
**OAuth 类型**: 标准 Authorization Code Flow + PKCE

### 1.1 OAuth 配置

| 配置项 | 值 |
|--------|-----|
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Authorization URL | `https://claude.ai/oauth/authorize` |
| Token URL | `https://console.anthropic.com/v1/oauth/token` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| Code Challenge Method | `S256` (PKCE) |

**请求的 Scopes:**
- `org:create_api_key`
- `user:profile`
- `user:inference`
- `user:sessions:claude_code`
- `user:mcp_servers`

> 关键文件: `src/lib/oauth/constants/oauth.ts:27-42`

### 1.2 OAuth 流程 (4步)

#### Step 1: 生成授权 URL

构造带 PKCE 的授权 URL，重定向用户到 Claude.ai 授权页面。

```
GET https://claude.ai/oauth/authorize?
  code=true&
  client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&
  response_type=code&
  redirect_uri=https://platform.claude.com/oauth/code/callback&
  scope=org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers&
  code_challenge=<SHA256_BASE64URL>&
  code_challenge_method=S256&
  state=<RANDOM_STATE>
```

> 关键文件: `src/lib/oauth/providers/claude.ts:6-18`

#### Step 2: 用户授权

用户在 Claude.ai 上登录并授权应用访问。

#### Step 3: 接收授权码

Claude.ai 重定向回调:
```
https://platform.claude.com/oauth/code/callback?code=<AUTH_CODE>&state=<STATE>
```

OmniRoute 会处理 code 中可能包含的 `#` 分隔符 (格式: `code#state-from-fragment`)。

#### Step 4: 用授权码换取 Token

**请求:**
```http
POST https://console.anthropic.com/v1/oauth/token
Content-Type: application/json
Accept: application/json
```

```json
{
  "code": "auth_code",
  "state": "state_value",
  "grant_type": "authorization_code",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "code_verifier": "pkce_verifier_string"
}
```

**响应:**
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 3600,
  "scope": "..."
}
```

> 关键文件: `src/lib/oauth/providers/claude.ts:19-56`

### 1.3 API 请求 Headers

向 Anthropic API 发起请求时使用的 Headers:

```http
Content-Type: application/json
Accept: text/event-stream        # 流式请求
Accept: application/json         # 非流式请求
Authorization: Bearer <ACCESS_TOKEN>
```

CORS 支持的额外 Headers: `anthropic-version`, `x-api-key`, `x-omniroute-connection`

> 关键文件: `open-sse/executors/base.ts:244-257`

### 1.4 API Endpoints

| 用途 | Endpoint |
|------|----------|
| 授权 | `GET https://claude.ai/oauth/authorize` |
| Token 交换 | `POST https://console.anthropic.com/v1/oauth/token` |
| API 请求 | `POST https://api.anthropic.com/v1/messages` |
| 内部保存 Token | `POST {server}/api/cli/providers/claude` |

### 1.5 Token 管理

- Token 保存到 OmniRoute 服务端数据库
- 保存请求使用 `Authorization: Bearer <SERVER_TOKEN>` + `X-User-Id` Headers
- 支持 Token 刷新 (通过 refresh_token)
- 不使用 Cookie / SessionKey

---

## 2. openclaw-billing-proxy

**技术栈**: Node.js (纯 JavaScript)
**OAuth 类型**: 读取 Claude Code CLI 本地凭证文件 (非标准 OAuth 流程)

### 2.1 OAuth 实现方式

openclaw-billing-proxy **不实现 OAuth 授权流程本身**，而是复用 Claude Code CLI 已经完成的 OAuth 认证，直接从本地文件系统读取已有的 Token。

**凭证读取优先级:**
1. `OAUTH_TOKEN` 环境变量
2. `~/.claude/.credentials.json`
3. `~/.claude/credentials.json`
4. config.json 中配置的 `credentialsPath`
5. macOS Keychain (仅 Darwin 系统):
   - `Claude Code-credentials`
   - `claude-code`
   - `claude`
   - `com.anthropic.claude-code`

**凭证文件格式:**
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-...",
    "expiresAt": 1234567890,
    "subscriptionType": "max"
  }
}
```

> 关键文件: `proxy.js:420-434`, `setup.js:51-101`

### 2.2 OAuth 流程 (依赖外部)

#### Step 1: 用户通过 Claude Code CLI 认证

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Claude Code CLI 处理完整的 OAuth 流程并将 Token 存储到本地。

#### Step 2: Proxy 读取本地 Token

每次请求时从 `~/.claude/.credentials.json` 读取最新的 `accessToken`。

#### Step 3: Token 过期处理

Token 约 24 小时过期。刷新方式:
- 重新打开 Claude Code CLI
- 运行 `claude -p "ping" --max-turns 1 --no-session-persistence`

Proxy 每次请求都从磁盘重新读取 Token (不缓存)。

### 2.3 API 请求 Headers

向 Anthropic API 发起请求时使用的 **完整 Headers** (伪装为 Claude Code CLI):

**核心 Headers:**
```http
Authorization: Bearer <oauth.accessToken>
Content-Type: application/json
anthropic-version: 2023-06-01
content-length: <body.length>
accept-encoding: identity
```

**Stainless SDK Headers (伪装 Claude Code 身份):**
```http
user-agent: claude-cli/2.1.97 (external, cli)
x-app: cli
x-claude-code-session-id: <INSTANCE_SESSION_ID>
x-stainless-arch: x64|arm64
x-stainless-lang: js
x-stainless-os: macOS|Windows|Linux
x-stainless-package-version: 0.81.0
x-stainless-runtime: node
x-stainless-runtime-version: <node_version>
x-stainless-retry-count: 0
x-stainless-timeout: 600
anthropic-dangerous-direct-browser-access: true
```

**Beta 功能 Headers:**
```http
anthropic-beta: oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,advanced-tool-use-2025-11-20,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24,fast-mode-2026-02-01
```

**Billing Header (注入到 System Prompt 中):**
```
x-anthropic-billing-header: cc_version=2.1.97.<fingerprint>; cc_entrypoint=cli; cch=00000;
```

> 关键文件: `proxy.js:133-153`, `proxy.js:803-817`

### 2.4 Billing Fingerprint 计算

```javascript
const BILLING_HASH_SALT = '59cf53e54c78';
const BILLING_HASH_INDICES = [4, 7, 20];
// 从第一条用户消息中取 [4,7,20] 位置的字符
// SHA256(salt + chars + version).slice(0, 3) → 3字符指纹
```

> 关键文件: `proxy.js:72-131`

### 2.5 API Endpoints

| 用途 | Endpoint |
|------|----------|
| 上游 API | `https://api.anthropic.com:443/v1/messages` |
| 本地代理 | `http://127.0.0.1:18801/v1/messages` |
| 健康检查 | `GET http://127.0.0.1:18801/health` |

### 2.6 请求变换管线 (7层)

openclaw-billing-proxy 对请求进行多层变换以避免检测:

| 层 | 技术 | 说明 |
|----|------|------|
| 1 | Billing Header | 动态 SHA256 指纹匹配 CC 格式 |
| 2 | 字符串替换 | 30+ 触发短语替换 |
| 3 | 工具名指纹 | `exec`→`Bash`, `message`→`SendMessage` 等 28 个重命名 |
| 4 | System 模板 | 去除 ~28K 配置，替换为 0.5K 简述 |
| 5 | 工具描述 | 移除 description 值 |
| 6 | 属性重命名 | `session_id`→`thread_id` 等 8 个重命名 |
| 7 | 元数据注入 | Device ID + Session ID + 伪造 CC 工具桩 |

响应返回时反转所有变换。

> 关键文件: `proxy.js:155-713` (变换), `proxy.js:716-739` (反转)

---

## 3. sub2api

**技术栈**: Go
**OAuth 类型**: 标准 Authorization Code Flow + PKCE + Cookie-Based Flow (双模式)

### 3.1 OAuth 配置

| 配置项 | 值 |
|--------|-----|
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Authorization URL | `https://claude.ai/oauth/authorize` |
| Token URL | `https://platform.claude.com/v1/oauth/token` |
| Redirect URI | `https://platform.claude.com/oauth/code/callback` |
| Code Challenge Method | `S256` (PKCE) |

**请求的 Scopes:**
- OAuth 模式: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- API 模式: `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- 推理模式: `user:inference`

> 关键文件: `backend/internal/pkg/oauth/oauth.go:16-35`

### 3.2 浏览器 OAuth 流程 (3步)

#### Step 1: 生成授权 URL

PKCE 生成: 32 字节随机数 → base64url (43字符)

```
GET https://claude.ai/oauth/authorize?
  code=true&
  client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&
  response_type=code&
  redirect_uri=https://platform.claude.com/oauth/code/callback&
  scope=org:create_api_key+user:profile+...&
  code_challenge=<SHA256_BASE64URL>&
  code_challenge_method=S256&
  state=<RANDOM_BASE64URL>
```

> 关键文件: `backend/internal/pkg/oauth/oauth.go:149-183`

#### Step 2: 用户授权

用户访问授权 URL，在 Claude.ai 上登录并确认授权。

#### Step 3: 用授权码换取 Token

**请求:**
```http
POST https://platform.claude.com/v1/oauth/token
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: axios/1.13.6
```

```json
{
  "code": "authorization_code",
  "grant_type": "authorization_code",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "code_verifier": "pkce_verifier_string",
  "state": "state_if_returned"
}
```

**响应:**
```json
{
  "access_token": "pat_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "...",
  "scope": "...",
  "organization": { "uuid": "org_uuid" },
  "account": { "uuid": "...", "email_address": "user@example.com" }
}
```

> 关键文件: `backend/internal/repository/claude_oauth_service.go:174-233`

### 3.3 Cookie-Based OAuth 流程 (4步)

使用已有的 `sessionKey` Cookie 自动获取 Token，无需用户交互。

#### Step 1: 获取 Organization UUID

```http
GET https://claude.ai/api/organizations
Cookie: sessionKey=<session_key>
```

**响应:** 返回组织列表，优先选择 `raven_type="team"` 的组织。

> 关键文件: `backend/internal/repository/claude_oauth_service.go:35-92`

#### Step 2: 获取授权码

```http
POST https://claude.ai/v1/oauth/{orgUUID}/authorize
Cookie: sessionKey=<session_key>
Accept: application/json
Accept-Language: en-US,en;q=0.9
Cache-Control: no-cache
Origin: https://claude.ai
Referer: https://claude.ai/new
Content-Type: application/json
```

```json
{
  "response_type": "code",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "organization_uuid": "org_uuid",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "scope": "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  "state": "random_state",
  "code_challenge": "S256_hash",
  "code_challenge_method": "S256"
}
```

**响应:**
```json
{
  "redirect_uri": "https://platform.claude.com/oauth/code/callback?code=AUTH_CODE&state=STATE"
}
```

> 关键文件: `backend/internal/repository/claude_oauth_service.go:94-172`

#### Step 3-4: 交换 Token

与浏览器流程相同，使用从 Step 2 获取的 code 交换 Token。

### 3.4 Token 刷新

```http
POST https://platform.claude.com/v1/oauth/token
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: axios/1.13.6
```

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "refresh_token_value",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

> 关键文件: `backend/internal/repository/claude_oauth_service.go:235-267`

### 3.5 API 请求 Headers

```http
Content-Type: application/json
Authorization: Bearer <access_token>
User-Agent: antigravity/<version> windows/amd64
```

> 关键文件: `backend/internal/pkg/antigravity/client.go:46-49`

### 3.6 API Endpoints

| 用途 | Endpoint |
|------|----------|
| 授权 (浏览器) | `GET https://claude.ai/oauth/authorize` |
| 授权 (Cookie) | `POST https://claude.ai/v1/oauth/{orgUUID}/authorize` |
| 获取组织 | `GET https://claude.ai/api/organizations` |
| Token 交换/刷新 | `POST https://platform.claude.com/v1/oauth/token` |
| API 请求 | `POST https://api.anthropic.com/v1/messages` (通过 antigravity 客户端) |

### 3.7 Session 管理

- 内存中 Session 存储，自动清理协程
- Session TTL: 30 分钟
- 清理间隔: 5 分钟
- Token 交换成功后删除 Session

> 关键文件: `backend/internal/pkg/oauth/oauth.go:37-60`

---

## 4. 三种实现对比汇总

### 4.1 核心差异对比

| 特性 | OmniRoute | openclaw-billing-proxy | sub2api |
|------|-----------|----------------------|---------|
| **语言** | TypeScript | JavaScript (Node.js) | Go |
| **OAuth 流程** | 标准 Authorization Code + PKCE | 不实现 OAuth (读取 CC 本地凭证) | 双模式: 标准 OAuth + Cookie-Based |
| **Client ID** | `9d1c250a...` | 不使用 (依赖 CC CLI) | `9d1c250a...` (相同) |
| **Token 交换 URL** | `console.anthropic.com/v1/oauth/token` | N/A | `platform.claude.com/v1/oauth/token` |
| **PKCE** | 支持 (S256) | N/A | 支持 (S256) |
| **Token 存储** | 服务端数据库 | 读取本地文件系统 | 内存 Session + 数据库 |
| **Token 刷新** | 通过 refresh_token | 依赖 CC CLI 自动刷新 | 通过 refresh_token |
| **Cookie/SessionKey** | 不支持 | 不支持 | 支持 (自动从 sessionKey 获取 Token) |
| **身份伪装** | 无 | 完整的 CC CLI 身份伪装 (7层变换) | 部分 (User-Agent 伪装) |
| **Billing 绕过** | 无 | 有 (动态指纹计算) | 无 |

### 4.2 Authorization URL 对比

三个仓库均使用相同的授权入口:
```
https://claude.ai/oauth/authorize
```

### 4.3 Token Exchange Endpoint 差异

| 仓库 | Token 交换 Endpoint |
|------|---------------------|
| OmniRoute | `https://console.anthropic.com/v1/oauth/token` |
| openclaw-billing-proxy | N/A (不做 Token 交换) |
| sub2api | `https://platform.claude.com/v1/oauth/token` |

> **注意**: OmniRoute 和 sub2api 使用了不同的 Token Endpoint 域名！

### 4.4 API 请求 Endpoint

三个仓库最终都向以下地址发起 API 请求:
```
https://api.anthropic.com/v1/messages
```

### 4.5 Header 差异对比

| Header | OmniRoute | openclaw-billing-proxy | sub2api |
|--------|-----------|----------------------|---------|
| `Authorization: Bearer` | ✅ | ✅ | ✅ |
| `Content-Type: application/json` | ✅ | ✅ | ✅ |
| `anthropic-version` | 支持 (CORS) | `2023-06-01` | 未显式设置 |
| `anthropic-beta` | 未设置 | 完整 beta 标志列表 | 未设置 |
| `user-agent` (CC 伪装) | 未设置 | `claude-cli/2.1.97` | `antigravity/<ver>` |
| `x-stainless-*` | 未设置 | 完整 Stainless SDK 系列 | 未设置 |
| `x-app: cli` | 未设置 | ✅ | 未设置 |
| Token 交换 `Content-Type` | `application/json` | N/A | `application/json` |
| Token 交换 `User-Agent` | 未设置 | N/A | `axios/1.13.6` |

### 4.6 设计思路差异

| 维度 | OmniRoute | openclaw-billing-proxy | sub2api |
|------|-----------|----------------------|---------|
| **定位** | 多 Provider 统一 OAuth 网关 | Claude Max/Pro 订阅代理 | 多 Provider API 中转服务 |
| **复杂度** | 中等 (标准 OAuth) | 高 (7 层请求变换) | 高 (双模式 OAuth) |
| **独立性** | 完全独立的 OAuth 实现 | 依赖 Claude Code CLI | 完全独立 + Cookie 自动化 |
| **多 Provider** | 支持 (Claude, OpenAI, Gemini 等) | 仅 Claude | 支持 (Claude, Google 等) |
| **检测规避** | 无 | 积极规避 (伪装 + 变换) | 轻度 (User-Agent) |

### 4.7 Git 仓库最新更新信息

| 仓库 | OAuth 相关代码最新 Commit | 提交时间 | 仓库整体最新 Commit | 提交时间 |
|------|--------------------------|---------|---------------------|---------|
| **OmniRoute** | `0cd388e` Release v3.7.4 (#1730) | 2026-04-28 20:46:25 -0300 | `99c6dc7` Release v3.7.9 (#1917) | 2026-05-04 01:36:53 -0300 |
| **openclaw-billing-proxy** | `a26821c` fix: preserve thinking/redacted_thinking blocks | 2026-04-09 16:44:32 -0700 | `502c63e` Merge PR #28 fix/preserve-thinking-blocks | 2026-04-10 15:21:20 -0700 |
| **sub2api** | `81ca4f1` 修复误删的url | 2026-03-28 00:55:55 +0800 | `df722c9` fix: remove OpenAI unknown model fallback | 2026-05-04 11:07:58 +0800 |
