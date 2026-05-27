# CLIProxyAPI Claude Code 实现分析

## 项目概览

**项目名称**: CLI Proxy API  
**Git Commit**: `21fad9db` (Merge pull request #3477 from router-for-me/cluster)  
**技术栈**: Go 1.26+  
**核心特性**: 
- 多供应商 API 网关（Claude/Codex/Gemini/Grok）
- OAuth 认证 + 本地凭证管理
- 多账户负载均衡（round-robin / fill-first）
- 会话亲和性（session-affinity）路由

---

## A. Claude Code → API 的实现逻辑

### A.1 认证 / 拿到上游凭据

#### OAuth 登录流程
CLIProxyAPI 实现了**完整独立的 OAuth 2.0 + PKCE** 认证流程，不复用本地 Claude Code CLI 凭证。

**关键文件**: `internal/auth/claude/anthropic_auth.go:23-32`

| 配置项 | 值 |
|--------|-----|
| Authorization URL | `https://claude.ai/oauth/authorize` |
| Token Exchange URL | `https://api.anthropic.com/v1/oauth/token` |
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| Redirect URI | `http://localhost:54545/callback` |
| Code Challenge Method | `S256` (PKCE) |
| Requested Scopes | `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` |

**三步 OAuth 流程**：
1. **生成授权 URL** (`GenerateAuthURL` in `anthropic_auth.go:190-200`)：生成 32 字节随机 PKCE challenge，构造授权 URL 并重定向用户
2. **用户授权**：用户在 Claude.ai 上登录并授权应用访问
3. **交换 Token** (`ExchangeCode` in `anthropic_auth.go`)：使用授权码 + PKCE verifier 交换 access_token + refresh_token

**Token 响应结构** (`tokenResponse` in `anthropic_auth.go:119-132`)：
```go
{
  "access_token": "sk-ant-...",
  "refresh_token": "...",
  "expires_in": 3600,
  "organization": {"uuid": "...", "name": "..."},
  "account": {"uuid": "...", "email_address": "..."}
}
```

#### Token 管理
**关键文件**: `internal/auth/claude/anthropic_auth.go:54-107`

- **自动刷新机制**：使用 `refresh_token` 自动刷新过期 token
- **并发控制**：`claudeRefreshGroup` (singleflight) + `claudeRefreshBlock` map 防止并发刷新同一 token
- **退避策略**：5秒-5分钟的指数退避，遵守 `Retry-After` header
- **故障转移**：429/503 等可重试错误自动重新尝试

**Token 存储位置**：
- 文件系统：`~/.cli-proxy-api/auths/` 目录（可配置）
- 内存字段：OAuth token 存储在 `Auth.Metadata["access_token"]` (in `claude_executor.go:1037-1040`)

#### OAuth 回调服务器
**关键文件**: `internal/auth/claude/oauth_server.go:22-108`

`OAuthServer` 实现本地 HTTP 服务器监听 OAuth 回调：
- 端口：54545（默认，可配置）
- 路由：`/callback` (获取 code + state), `/success` (成功提示页面)
- 超时：10 秒读写超时，5 秒优雅关闭超时

### A.2 请求转换

#### 上游凭据提取与选择
**关键文件**: `internal/runtime/executor/claude_executor.go:1029-1043`

```go
func claudeCreds(a *cliproxyauth.Auth) (apiKey, baseURL string) {
  // 1. 优先从 Attributes["api_key"] 获取（API Key 模式）
  // 2. 降级到 Metadata["access_token"]（OAuth 模式）
  if a != nil {
    if a.Attributes != nil {
      apiKey = a.Attributes["api_key"]
      baseURL = a.Attributes["base_url"]
    }
    if apiKey == "" && a.Metadata != nil {
      if v, ok := a.Metadata["access_token"].(string); ok {
        apiKey = v
      }
    }
  }
  return
}
```

#### 请求头注入 (Mimicry / 伪装)
**关键文件**: `internal/runtime/executor/claude_executor.go:917-1027`

**函数**: `applyClaudeHeaders()`

关键 Headers 设置：

| Header | 值 | 说明 |
|--------|-----|------|
| `Authorization` | `Bearer <token>` | OAuth token（如果 api_key 模式使用 `x-api-key` 替代） |
| `x-api-key` | `<api_key>` | API Key 模式且目标是 `api.anthropic.com` |
| `Content-Type` | `application/json` | |
| `Anthropic-Beta` | `claude-code-20250219,oauth-2025-04-20,...` | Beta features（在第 950 行写死） |
| `Anthropic-Version` | `2023-06-01` | API 版本 |
| `Anthropic-Dangerous-Direct-Browser-Access` | `true` | 仅 API Key 模式设置（第 982 行）|
| `X-App` | `cli` | 伪装为 Claude Code CLI（第 985 行）|
| `X-Claude-Code-Session-Id` | `<cached_session_id>` | 稳定的 session ID（第 992 行）|
| `x-client-request-id` | `<uuid>` | 每次请求生成新 UUID（第 995 行）|
| `User-Agent` | `claude-cli/...` | 伪装版本（由 `ApplyClaudeLegacyDeviceHeaders` 设置）|
| `X-Stainless-*` | 多个 | SDK 指纹（Runtime=node, Lang=js, Timeout=600 等）|
| `Accept` | `text/event-stream` / `application/json` | 流式 vs 非流式 |
| `Accept-Encoding` | `identity` (流式) / `gzip, deflate, br, zstd` (非流式) | |

**设备指纹稳定化** (第 944-948 行)：
如果 `cfg.ClaudeDeviceProfile.Stabilize` 启用，则使用配置的设备标识而非运行时检测。

#### System Prompt 注入 / 伪装
**关键文件**: `internal/runtime/executor/claude_executor.go:161-163`

```go
// Apply cloaking (system prompt injection, fake user ID, sensitive word obfuscation)
// based on client type and configuration.
body = applyCloaking(ctx, e.cfg, auth, body, baseModel, apiKey)
```

`applyCloaking()` 函数（具体实现不在当前摘录范围）实现：
- 对非官方 Claude Code 客户端的 OAuth 请求注入系统提示
- 注入虚假 User ID
- 敏感词混淆

#### 模型名映射
**关键文件**: `internal/runtime/executor/claude_executor.go:154-155`

```go
baseModel := thinking.ParseSuffix(req.Model).ModelName
body, _ = sjson.SetBytes(body, "model", baseModel)
```

支持模型后缀（如 `claude-3.5-sonnet::thinking`），自动提取基础模型名。

#### OAuth Tool 重命名（伪装工具调用）
**关键文件**: `internal/runtime/executor/claude_executor.go:51-66, 1099-1127`

对 OAuth token，自动将第三方工具名映射到官方 Claude Code 工具名，避免被 Anthropic 的工具指纹检测识别为第三方客户端：

```go
var oauthToolRenameMap = map[string]string{
  "bash": "Bash",
  "read": "Read",
  "write": "Write",
  "edit": "Edit",
  "glob": "Glob",
  "grep": "Grep",
  // ... 共 16 个工具
}
```

请求时的流程 (第 194-196 行)：
1. 如果 apiKey 是 OAuth token (`sk-ant-oat`)
2. 调用 `prepareClaudeOAuthToolNamesForUpstream()`：
   - 重映射工具名为 TitleCase
   - 记录反向映射表（用于响应时恢复）

响应时反向恢复 (第 294 行)：`restoreClaudeOAuthToolNamesFromResponse()`

#### 签名 (CCH Signing)
**关键文件**: `internal/runtime/executor/claude_executor.go:199-202`

```go
if oauthToken || experimentalCCHSigningEnabled(e.cfg, auth) {
  bodyForUpstream = signAnthropicMessagesBody(bodyForUpstream)
}
```

对 OAuth token 请求自动签名消息体 (CCH protocol)，与 Claude Code 官方行为一致。

#### 缓存控制注入
**关键文件**: `internal/runtime/executor/claude_executor.go:175-186`

自动补充缺失的 cache_control blocks（优化对不支持缓存的客户端）：
- 在 system/tools/messages 中自动注入 cache_control
- 强制执行 Anthropic 的 4 个 cache_control block 上限
- 规范化 TTL 值防止排序冲突

#### 思考块(Thinking)处理
**关键文件**: `internal/runtime/executor/claude_executor.go:156, 334, 375`

```go
body, err = thinking.ApplyThinking(body, req.Model, from.String(), to.String(), e.Identifier())
```

支持 interleaved-thinking beta 特性的自动转换和验证。

#### 最终请求构建
**关键文件**: `internal/runtime/executor/claude_executor.go:204-209`

```go
url := fmt.Sprintf("%s/v1/messages?beta=true", baseURL)
httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(bodyForUpstream))
// ...
applyClaudeHeaders(httpReq, auth, apiKey, false, extraBetas, e.cfg)
httpClient := helps.NewUtlsHTTPClient(e.cfg, auth, 0)
httpResp, err := httpClient.Do(httpReq)
```

- URL: `https://api.anthropic.com/v1/messages?beta=true` (或自定义 baseURL)
- HTTP 方法: `POST`
- 使用自定义 TLS client（Firefox 指纹以绕过 Cloudflare 检测）

### A.3 响应处理

#### 流式响应 (SSE)
**关键文件**: `internal/runtime/executor/claude_executor.go:310-529`

`ExecuteStream()` 方法：
1. 接收 HTTP 响应流
2. 按行解析 SSE 格式 (bufio.Scanner)
3. 逐行转换 (如需转换格式)
4. 恢复 Tool 名称映射 (第 462, 494 行)
5. 解析 Token 用量 (第 459, 491 行)
6. 转发给客户端

**关键点**: 
- SSE 流必须无压缩 (`Accept-Encoding: identity`)
- 支持 50MB 缓冲（第 455, 485 行 `scanner.Buffer(nil, 52_428_800)`）

#### 非流式响应
**关键文件**: `internal/runtime/executor/claude_executor.go:130-308`

`Execute()` 方法：
1. 全部读取响应体
2. 验证 Claude 流式响应格式 (如返回流式数据)
3. 解析 Token 用量
4. 恢复 Tool 名称映射
5. 格式转换 (若需要)
6. 返回给客户端

#### Token 计数 / 用量统计
**关键文件**: `internal/runtime/executor/claude_executor.go:287-293`

```go
// 流式
if detail, ok := helps.ParseClaudeStreamUsage(line); ok {
  reporter.Publish(ctx, detail)
}

// 非流式
reporter.Publish(ctx, helps.ParseClaudeUsage(data))
```

`reporter` 实现精细的 Token 级用量跟踪。

#### 错误重试
**关键文件**: `internal/runtime/executor/claude_executor.go:235-260`

- 非 2xx 状态码直接返回错误
- HTTP 层面的重试由上级调度器处理（round-robin 切换账户）
- 支持 `max-retry-credentials` 配置限制重试次数

---

## B. 多 API Key + 独立额度的支持情况

### B.1 对外多 API Key 支持

**答案**: ✅ **支持**

**关键文件**: 
- `internal/config/sdk_config.go:34-35`
- `config.example.yaml:38-42`

**配置示例**:
```yaml
api-keys:
  - "your-api-key-1"
  - "your-api-key-2"
  - "your-api-key-3"
```

**认证机制**:
- 客户端在 HTTP Header 中发送 API Key
- 服务端对每个请求验证 API Key 存在于 `cfg.APIKeys` 列表

### B.2 每个 Key 独立额度 (Quota / Rate Limit)

**答案**: ⚠️ **部分支持**，但不完全

**已支持的功能**

**关键文件**: `internal/api/handlers/management/api_key_usage.go:12-107`

- **请求计数** (success/failed)：通过 `Auth.Success` / `Auth.Failed` 计数器（第 93-96 行）
- **时间窗口统计**：`Auth.RecentRequestsSnapshot(now)` 提供最近请求的桶统计（第 86 行）
- **数据结构**:

```go
type apiKeyUsageEntry struct {
  Success        int64  // 成功请求数
  Failed         int64  // 失败请求数
  RecentRequests []coreauth.RecentRequestBucket  // 时间窗口内请求
}
```

- **用量查询端点**：`GET /v0/management/api-key-usage` 返回所有 API Key 的用量统计

**缺失的功能**

1. **无"硬限额"机制**：配置中找不到 `quota_limit`, `rate_limit`, `daily_limit` 字段
   - 即无法配置"每日最多 X 次请求"或"每小时最多 Y 次"
   
2. **无"额度超出自动拒绝"**：虽然有 `QuotaExceeded` 配置（`internal/config/config.go:92-93`），但它控制的是行为而非限制：
   ```yaml
   quota-exceeded:
     switch-project: true       # 当额度用尽时自动切换到另一个项目
     switch-preview-model: true # 自动降级模型
     antigravity-credits: true  # 使用 credits 备份
   ```
   这些是**切换策略**，不是硬限额。

3. **无 Per-API-Key Quota 配置**：`api-keys` 是简单的字符串列表，无字段存储每个 key 的限额：
   ```yaml
   api-keys:
     - key1  # 无关联的限额配置
     - key2
   ```

### B.3 多上游订阅共享 / 分发策略

**答案**: ✅ **支持多种负载均衡策略**

**关键文件**: 
- `internal/config/config.go:96` - Routing 配置
- `config.example.yaml:113-123` - routing 策略示例

**支持的策略**：

| 策略 | 说明 | 配置 |
|------|------|------|
| **Round-Robin** | 循环分发，轮流选择下一个凭证 | `routing.strategy: "round-robin"` (默认) |
| **Fill-First** | 优先填满当前凭证的并发，再切换 | `routing.strategy: "fill-first"` |
| **Session Affinity** | 会话粘性：相同会话的请求总是用同一凭证 | `routing.session-affinity: true` |

**会话识别方式** (`config.example.yaml:117-120`)：
```
会话 ID 提取自:
- metadata.user_id (Claude Code session format)
- X-Session-ID (custom header)
- Session_id (Codex)
- X-Amp-Thread-Id (Amp CLI)
- X-Client-Request-Id (PI)
- conversation_id (OpenAI format)
- 或前几条消息哈希
```

**Session TTL**: `routing.session-affinity-ttl: "1h"` (默认 1 小时)

**故障转移**: 如果绑定的凭证不可用，自动故障转移到其他凭证

### B.4 反向场景：1 对外 Key + 多上游订阅

**答案**: ✅ **支持**，通过 **多 Credentials/Auths 配置**

**关键文件**: 
- `internal/auth/` - 支持多种认证类型
- `config.example.yaml:150-200+` - 多个 `claude-api-key`, `codex-api-key` 等

**方式**：
1. 对外仅配置 1 个 `api-key`
2. 后端配置多个 Claude OAuth 账户或多个 Codex 项目（在 `internal/auth/` 下的各个文件中管理）
3. 路由器根据 `routing.strategy` 从多个上游账户中分发请求

**例子**：
```yaml
api-keys:
  - "client-key-123"    # 对外只有这一个

# 后端配置 3 个 Claude OAuth 账户
# (通过 TUI 或 Management API 添加，存储在 ~/.cli-proxy-api/auths/)
```

所有来自 `client-key-123` 的请求会按 round-robin 分发给 3 个后端 Claude 账户。

---

## C. 核心代码位置速查表

| 功能 | 文件 | 行号/函数 |
|------|------|---------|
| **OAuth 认证流程** | `internal/auth/claude/anthropic_auth.go` | `GenerateAuthURL:190`, `ExchangeCode`, `RefreshToken` |
| **Token 自动刷新** | `internal/auth/claude/anthropic_auth.go` | `claudeRefreshGroup:35-36`, `claudeRefreshBlock:37` |
| **OAuth 回调服务器** | `internal/auth/claude/oauth_server.go` | `OAuthServer:22`, `Start:72`, `WaitForCallback:150` |
| **凭证提取** | `internal/runtime/executor/claude_executor.go` | `claudeCreds:1029` |
| **请求头注入** | `internal/runtime/executor/claude_executor.go` | `applyClaudeHeaders:917` |
| **System Prompt 伪装** | `internal/runtime/executor/claude_executor.go` | `applyCloaking:163` |
| **Tool 重命名** | `internal/runtime/executor/claude_executor.go` | `remapOAuthToolNames:1099`, `oauthToolRenameMap:51` |
| **CCH 签名** | `internal/runtime/executor/claude_executor.go` | `signAnthropicMessagesBody:201` |
| **流式响应处理** | `internal/runtime/executor/claude_executor.go` | `ExecuteStream:310` |
| **非流式响应处理** | `internal/runtime/executor/claude_executor.go` | `Execute:130` |
| **API Key 配置** | `internal/config/sdk_config.go` | `APIKeys:34-35` |
| **API Key 使用统计** | `internal/api/handlers/management/api_key_usage.go` | `GetAPIKeyUsage:45` |
| **路由策略** | `internal/config/config.go` | `Routing:96`, `RoutingConfig` |
| **多账户负载均衡** | 配置驱动 | `routing.strategy`, `routing.session-affinity` |

---

## D. 与 Sub2API 的主要差异

| 维度 | CLIProxyAPI | Sub2API |
|------|-----------|---------|
| **OAuth 实现** | 完全独立实现 + 本地回调服务器 | 完全独立实现 + sessionKey Cookie 自动化 |
| **Token 交换端点** | `https://api.anthropic.com/v1/oauth/token` | `https://platform.claude.com/v1/oauth/token` |
| **Tool 伪装** | OAuth 才重映射，非 OAuth 不转换 | 全部请求都转换（7层变换管线） |
| **负载均衡策略** | round-robin/fill-first + session affinity | Sticky Session + 负载感知 |
| **API Key 管理** | 简单列表，无内置额度控制 | 数据库驱动，支持多维度配额 |
| **设备指纹** | 支持稳定化配置 | 不详 |
| **缓存控制** | 自动注入 + TTL 规范化 | 自动注入 |

---

## E. 多 API Key + 独立额度 - 需要改造的地方

如果需要完全支持"多对外 API Key + 每个 Key 独立额度"，需要：

1. **配置数据结构扩展**:
   ```yaml
   api-keys:
     - key: "client-key-1"
       quota:
         daily: 1000000      # 每日 100 万 token
         hourly: 50000       # 每小时 5 万 token
         per_request_max: 10000  # 单次请求最大 1 万 token
     - key: "client-key-2"
       quota:
         daily: 500000
   ```

2. **数据库持久化**:
   - 当前只有内存统计 (`Auth.Success/Failed + RecentRequests`)
   - 需要持久化配额值和实时消费量

3. **请求拦截中间件**:
   - 在 Gin 中间件中验证当前 API Key 的配额余额
   - 超出时返回 429 Quota Exceeded

4. **相关代码位置改造**:
   - `internal/config/config.go` - 扩展 APIKey 结构
   - `internal/api/middleware/` - 添加 Quota 验证中间件
   - `internal/api/handlers/management/` - 新增 Quota 管理端点
