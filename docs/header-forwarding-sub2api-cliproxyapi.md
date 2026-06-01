# Sub2API → CliProxyAPI → Anthropic 链路上的 Header 处理

## 调研基准（代码版本快照）

| 仓库 | 路径 | 分支 | Commit | 提交时间 |
|---|---|---|---|---|
| Sub2API (v2 worktree) | `worktrees/v2/` | `feat/add-cliproxy` | `c93a6cbc66626698638a5640b8378c14d7c3f7bc` | 2026-05-25 00:42:58 -0700 |
| CliProxyAPI | `third_party/CLIProxyAPI/` | `main` | `05b972479aeb6885235e8d363cdc8a15be41fd6f` | 2026-06-01 11:27:10 +0800 |

> 验证方法：`git -C <repo> rev-parse HEAD`。若后续两侧代码更新，请重新读取相同文件区段确认结论是否还成立。本文件所有行号都基于上述 commit。

## 问题

1. Sub2API 在转发 Claude 请求时，会不会自己注入额外的 Header？
2. 这些 Header 传到 CliProxyAPI 之后会被原封不动转给 `api.anthropic.com` 吗？

## 结论速览

- **Sub2API 不"创造"伪装 Header。** 它走「客户端入站白名单透传 + 鉴权替换 + 两个必需字段兜底」三件事。
- **CliProxyAPI 也不"原样转发"。** 它在 `applyClaudeHeaders` 里重新构造一份发往 Anthropic 的 Header，但对 Claude Code 客户端指纹相关字段（`Anthropic-Beta` / `X-App` / `X-Stainless-*` / `X-Claude-Code-Session-Id` 等）采用「入站值优先、缺省回退硬编码默认」策略，因此 Sub2API 透传上来的客户端原值在多数情况下会被保留。
- **「入站优先」主要适用于 Claude Code 的指纹类 Header，不适用于鉴权。** 鉴权在两个代理上都有覆盖逻辑：Claude Code → Sub2API 的鉴权只用于 Sub2API 自身鉴权；Sub2API → CliProxyAPI 会改写为 Sub2API 中 CliProxy 账号配置的 `credentials.api_key`；CliProxyAPI → Anthropic 会再改写为 CliProxyAPI 自己选中的 Claude auth / OAuth token。
- 默认情况下会被 CliProxyAPI 覆盖的：鉴权（`Authorization` / `x-api-key`）、`Content-Type`、`Accept`、`Accept-Encoding`、`Connection`，以及 `Anthropic-Beta` 上对 `oauth-2025-04-20` / `interleaved-thinking-2025-05-14` 的强制合并。例外：CliProxyAPI auth 的 `header:*` 自定义 Header 会在最后再覆盖一层；SSE 模式下 `Accept-Encoding: identity` 会随后再次强制。

## 一、Sub2API 侧的 Header 行为

> **2026-05-31 更新**：`AccountTypeCLIProxy` 与 `AccountTypeAPIKey + anthropic_passthrough` 在 build 函数顶层根据 `account.IsCLIProxy()` 拆成了两条 Header 处理路径，语义相反：
>
> - **APIKey passthrough**（本节 1.A 描述的旧行为）：仍走「白名单透传 + 鉴权替换 + Content-Type/Anthropic-Version 兜底」。
> - **CliProxyAPI**（本节 1.B 描述的新行为）：业务/应用层 Header 全透传，**不维护白名单**，**不再兜底**任何字段；只替换鉴权 + 删除 Cookie + strip RFC 7230 §6.1 hop-by-hop Header。
>
> 详见 §1.B 与 [`cliproxyapi-integration-plan.md` §V1.3](./cliproxyapi-integration-plan.md)。

### 1.A APIKey passthrough（白名单转发模式）

APIKey passthrough 类型仍然走 `GatewayService.buildUpstreamRequestAnthropicAPIKeyPassthrough` 的非-CLIProxy 分支：

文件：`worktrees/v2/backend/internal/service/gateway_service.go:5218-5278`

**第一步：从入站 `c.Request.Header` 按白名单透传**

白名单定义在同文件 `gateway_service.go:359-381`（`allowedHeaders`）：

```
accept, accept-language, accept-encoding, content-type, user-agent, sec-fetch-mode,
anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, x-app,
x-stainless-retry-count, x-stainless-timeout, x-stainless-lang,
x-stainless-package-version, x-stainless-os, x-stainless-arch,
x-stainless-runtime, x-stainless-runtime-version, x-stainless-helper-method,
x-claude-code-session-id, x-client-request-id
```

白名单外的 Header（含 `cookie` 以及任何业务自定义字段）会被丢弃。

**第二步：强制覆盖鉴权 + 兜底两个必需字段**（5256–5268 行）

```go
req.Header.Del("authorization")
req.Header.Del("x-api-key")
req.Header.Del("x-goog-api-key")
req.Header.Del("cookie")
setHeaderRaw(req.Header, "x-api-key", token)   // token = CliProxy 账号的 credentials.api_key

if getHeaderRaw(req.Header, "content-type") == "" {
    setHeaderRaw(req.Header, "content-type", "application/json")
}
if getHeaderRaw(req.Header, "anthropic-version") == "" {
    setHeaderRaw(req.Header, "anthropic-version", "2023-06-01")
}
```

结论：**Sub2API 不会主动新增 `anthropic-beta` / `x-app` / `x-stainless-*` 等伪装字段，也不会替换成 Sub2API 自己的客户端指纹。** 只要客户端（如 Claude Code CLI）本来就带，Sub2API 会按白名单原样发给下游 CliProxyAPI；不带就不会有。Sub2API 唯一替你做的"伪装"是：缺失时补 `anthropic-version: 2023-06-01`。与此相反，鉴权字段不是透传：入站 `Authorization` / `x-api-key` / `x-goog-api-key` 会被删除，并改写为 CliProxy 账号的 `credentials.api_key`。

### 1.B CliProxyAPI 账号：原样转发模式

`AccountTypeCLIProxy` 走同一 build 函数的 `account.IsCLIProxy()` 分支，扮演**合规反向代理**：

文件：`worktrees/v2/backend/internal/service/gateway_service.go:5218-5278`（`/v1/messages`）与 `:9201-9259`（`/v1/messages/count_tokens`）

```go
if account.IsCLIProxy() {
    copyInboundHeadersForCLIProxy(req.Header, c.Request.Header)
} else {
    // §1.A 描述的白名单循环
}
replaceInboundAuthWithAPIKey(req.Header, token)
delHeaderRaw(req.Header, "cookie")
if !account.IsCLIProxy() {
    // §1.A 描述的 content-type / anthropic-version 兜底
}
```

规则（详见 `copyInboundHeadersForCLIProxy` 与 `replaceInboundAuthWithAPIKey`）：

1. **业务/应用层 Header 全透传**——不再做白名单。客户端带 `X-Custom-Trace` / `X-Future-Claude-Code-Header` / 任何 `X-Stainless-*` 都原样转发。动机：未来 Claude Code 升级新增 Header 时 Sub2API 不必跟随升级。
2. **strip RFC 7230 §6.1 hop-by-hop Header**：`Connection` / `Keep-Alive` / `Proxy-Authenticate` / `Proxy-Authorization` / `Proxy-Connection` / `TE` / `Trailer` / `Transfer-Encoding` / `Upgrade`；同时解析 `Connection` value 中列出的动态 hop-by-hop 字段一并 strip。
3. **鉴权替换**：删除 `Authorization` / `x-api-key` / `x-goog-api-key`（使用 `delHeaderRaw` 同时清掉 canonical / wire-casing / raw 三种 map key 形式，防止小写 `"authorization"` 残留），写入 `x-api-key: <CliProxyAPI 账号 credentials.api_key>`。
4. **删除 `Cookie`**：避免跨边界泄漏会话凭据。Sub2API → CliProxyAPI 是后端 API 调用链路，不存在合法的 Cookie 透传场景。
5. **不再兜底 `Content-Type` / `Anthropic-Version`**：客户端没带就不补。让 CliProxyAPI 后端自己用 `applyClaudeHeaders` 决定兜底。
6. **不再合并 `Anthropic-Beta`**：oauth / interleaved-thinking 等合并由 CliProxyAPI 一侧的 `applyClaudeHeaders` 负责（参见 §二.2）。

不动的部分：响应方向 Header 过滤（`writeAnthropicPassthroughResponseHeaders`）、OAuth/Vertex/Bedrock 等其它 build 路径、`allowedHeaders` 常量本身（仍服务于 §1.A 与其它路径）。

## 二、CliProxyAPI 侧的 Header 行为

CliProxyAPI 收到 Sub2API 转发的请求后，**不会直接把入站 Header 整张转发**。它在 executor 里重新构造一份 outbound 请求，调用：

文件：`third_party/CLIProxyAPI/internal/runtime/executor/claude_executor.go:244, 421, 658` 都会调用：

```go
applyClaudeHeaders(httpReq, auth, apiKey, stream, extraBetas, e.cfg)
```

`applyClaudeHeaders` 定义在 `claude_executor.go:957-1066`。处理分以下几类：

### 1. 鉴权（强制覆盖，不读入站）

`claude_executor.go:970-977`

- 上游是 `api.anthropic.com` 且 auth 是 API Key 模式 → `Del("Authorization")` + `Set("x-api-key", apiKey)`
- 否则 → `Set("Authorization", "Bearer "+apiKey)`

Sub2API 上行带的那个 `x-api-key` 在这里会被替换成 CliProxyAPI 自己的 token。

这里的「CliProxyAPI 自己的 token」来自 CliProxyAPI 当前选中的 Claude auth：API Key 模式使用 auth `Attributes["api_key"]`，OAuth 模式可从 auth metadata 里的 `access_token` 回退获取。它不是 Claude Code 客户端发给 Sub2API 的 key，也不是 Sub2API 用来访问 CliProxyAPI 的 key。

### 2. `Anthropic-Beta`（入站为 base + 强制合并 + 请求体 betas 叠加）

`claude_executor.go:990-1018`

```go
baseBetas := "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15,fast-mode-2026-02-01,redact-thinking-2026-02-12,token-efficient-tools-2026-03-28"
if val := strings.TrimSpace(ginHeaders.Get("Anthropic-Beta")); val != "" {
    baseBetas = val
    if !strings.Contains(val, "oauth") {
        baseBetas += ",oauth-2025-04-20"
    }
}
if !strings.Contains(baseBetas, "interleaved-thinking") {
    baseBetas += ",interleaved-thinking-2025-05-14"
}
// + 请求体里的 extraBetas
```

入站有值就以入站值为 base，没有才用硬编码那一长串。**Sub2API 透传的客户端 `anthropic-beta` 在这里会被保留并扩展，不会被丢。**

### 3. 一组指纹 Header（入站优先、否则用默认值）

`claude_executor.go:1020-1035` 全部通过 `misc.EnsureHeader`：

| Header | 默认值 |
|---|---|
| `Anthropic-Version` | `2023-06-01` |
| `Anthropic-Dangerous-Direct-Browser-Access` | `true`（仅 API Key 模式） |
| `X-App` | `cli` |
| `X-Stainless-Retry-Count` | `0` |
| `X-Stainless-Runtime` | `node` |
| `X-Stainless-Lang` | `js` |
| `X-Stainless-Timeout` | `600` |
| `X-Claude-Code-Session-Id` | `helps.CachedSessionID(apiKey)` |
| `x-client-request-id` | `uuid.New().String()`（仅 `api.anthropic.com` 基址） |

`misc.EnsureHeader` 的语义见 `third_party/CLIProxyAPI/internal/misc/header_utils.go:109-125`：

```go
func EnsureHeader(target http.Header, source http.Header, key, defaultValue string) {
    if target == nil { return }
    if source != nil {
        if val := strings.TrimSpace(source.Get(key)); val != "" {
            target.Set(key, val)
            return
        }
    }
    if strings.TrimSpace(target.Get(key)) != "" { return }
    if val := strings.TrimSpace(defaultValue); val != "" {
        target.Set(key, val)
    }
}
```

——**source（入站 ginHeaders）有非空值就用入站，否则才用默认值。**

`ginHeaders` 的来源在 `claude_executor.go:980-983`：

```go
var ginHeaders http.Header
if ginCtx, ok := r.Context().Value("gin").(*gin.Context); ok && ginCtx != nil && ginCtx.Request != nil {
    ginHeaders = ginCtx.Request.Header
}
```

也就是 CliProxyAPI 那一侧收到的 HTTP 请求的 Header，即 Sub2API 上行透传过来的那批。

### 4. 强制硬编码字段（不看入站）

`claude_executor.go:978, 1037-1047`

```go
r.Header.Set("Content-Type", "application/json")
r.Header.Set("Connection", "keep-alive")
if stream {
    r.Header.Set("Accept", "text/event-stream")
    r.Header.Set("Accept-Encoding", "identity")   // SSE 不允许压缩
} else {
    r.Header.Set("Accept", "application/json")
    r.Header.Set("Accept-Encoding", "gzip, deflate, br, zstd")
}
```

### 5. 设备指纹（OS/Arch/User-Agent 等）

`claude_executor.go:1051-1055`：

- 稳定化模式（`ClaudeDeviceProfileStabilizationEnabled`）→ `helps.ApplyClaudeDeviceProfileHeaders` 用 baseline 覆盖 OS/Arch，允许更新软件指纹
- 否则 → `helps.ApplyClaudeLegacyDeviceHeaders(r, ginHeaders, cfg)`，部分基于入站 UA 推断

### 6. auth.Attributes 上的自定义 Header（最后兜底覆盖）

`claude_executor.go:1056-1060`：`util.ApplyCustomHeadersFromAttrs(r, attrs)` 会再覆盖一层。SSE 模式下随后再次强制 `Accept-Encoding: identity`（1064–1066 行）。

因此，本文中标注为 CliProxyAPI「强制」或「默认覆盖」的 Header，默认配置下结论成立；如果 CliProxyAPI 的 auth 配置了 `header:<Header-Name>`，该自定义 Header 会在最后覆盖内置值。SSE 模式下 `Accept-Encoding` 是例外，因为自定义 Header 之后还会被重设为 `identity`。

## 三、端到端各字段最终值表

| Header | 客户端 → Sub2API | Sub2API → CliProxyAPI | CliProxyAPI → Anthropic |
|---|---|---|---|
| `Authorization` | 客户端值 | **删除** | 不发（API Key 模式）/ `Bearer <CliProxy token>` |
| `x-api-key` | 客户端值 | **替换为 CliProxy 账号 token** | **再替换为 CliProxyAPI 自己的 token** |
| `anthropic-version` | 客户端值 | 透传，缺省补 `2023-06-01` | 入站优先，否则 `2023-06-01` |
| `anthropic-beta` | 客户端值 | 透传（白名单内） | 入站为 base + 强制合并 oauth/interleaved + body extras |
| `x-app` | 客户端值 | 透传（白名单内） | 入站优先，否则 `cli` |
| `x-stainless-*` | 客户端值 | 透传（白名单内） | 入站优先，否则各自硬编码默认 |
| `x-claude-code-session-id` | 客户端值 | 透传（白名单内） | 入站优先，否则 `CachedSessionID(apiKey)` |
| `x-client-request-id` | 客户端值 | 透传（白名单内） | 入站优先，否则 `uuid.New()`（仅 anthropic.com） |
| `user-agent` | 客户端值 | 透传（白名单内） | 走设备指纹策略，可能覆盖 |
| `content-type` | 客户端值 | 透传，缺省补 `application/json` | **强制** `application/json` |
| `accept` / `accept-encoding` | 客户端值 | 透传（白名单内） | **强制覆盖**（按 stream 选值） |
| `connection` | 客户端值 | 不在白名单，丢弃 | **强制** `keep-alive` |
| `cookie` / 业务自定义 | 客户端值 | **不在白名单，丢弃** | 不会出现 |

鉴权链路要和指纹 Header 分开看：Claude Code 发给 Sub2API 的鉴权只用于通过 Sub2API；Sub2API 发给 CliProxyAPI 的鉴权来自 Sub2API 的 CliProxy 账号配置；CliProxyAPI 发给 Anthropic 的鉴权来自 CliProxyAPI 自己的 Claude auth。`Anthropic-Beta` / `X-App` / `X-Stainless-*` / `X-Claude-Code-Session-Id` 这类客户端指纹字段才是「入站优先」的主要适用对象。

## 四、复现命令

```bash
# 验证 Sub2API 侧代码版本
git -C worktrees/v2 rev-parse HEAD
# 期望：c93a6cbc66626698638a5640b8378c14d7c3f7bc

# 验证 CliProxyAPI 侧代码版本
git -C third_party/CLIProxyAPI rev-parse HEAD
# 期望：05b972479aeb6885235e8d363cdc8a15be41fd6f

# 关键函数定位
grep -n "buildUpstreamRequestAnthropicAPIKeyPassthrough\|^var allowedHeaders" \
  worktrees/v2/backend/internal/service/gateway_service.go
grep -n "func applyClaudeHeaders\|func EnsureHeader" \
  third_party/CLIProxyAPI/internal/runtime/executor/claude_executor.go \
  third_party/CLIProxyAPI/internal/misc/header_utils.go
```
