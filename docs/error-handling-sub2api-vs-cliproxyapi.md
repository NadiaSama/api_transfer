# Sub2API 与 CLIProxyAPI 的错误码处理对比

> 目的：为 CodeX review 中的 Finding #4（cliproxy AccountType 是否应该继续走 Sub2API 的 failover 语义）提供决策依据。
>
> 范围：仅讨论"上游返回非 2xx HTTP 状态码"这条路径。客户端断连、请求体校验、入站鉴权等错误不在本文档范围。

---

## 1. Sub2API 的错误码处理

Sub2API 是面向终端用户的网关，账号是它内部的"上游资源池"，所以它的错误处理策略本质上是**面向账号池的"挑选下一个可用账号"**，而不是把错误原样返回客户端。

### 1.1 三层处理分支

`internal/service/gateway_service.go` 接到上游响应后会走三条不同的分支，分支判断核心是 `shouldFailoverUpstreamError` 与 `shouldRetryUpstreamError`：

```go
// gateway_service.go:3822
func (s *GatewayService) shouldFailoverUpstreamError(statusCode int) bool {
    switch statusCode {
    case 401, 403, 429, 529:
        return true
    default:
        return statusCode >= 500
    }
}

// gateway_service.go:3811
func (s *GatewayService) shouldRetryUpstreamError(account *Account, statusCode int) bool {
    if account.IsOAuth() {
        return statusCode == 403   // OAuth 仅在 403 时进入重试
    }
    return !account.ShouldHandleErrorCode(statusCode)
}
```

| 上游状态码 | shouldFailover | shouldRetry (apikey) | 客户端最终看到的状态码 |
|---|---|---|---|
| 200..399 | — | — | 原样 |
| 400 | false | by config | **400**（响应体原样透传 `c.Data(...)`） |
| 401 | true | by config | **502** + `upstream_error` |
| 403 | true | by config | **502** + `upstream_error` |
| 404 | false | by config | 502 + `upstream_error` |
| 408 | false | by config | 502 + `upstream_error` |
| 429 | true | by config | **429** + `rate_limit_error` |
| 500/502/503/504 | true | by config | 502 + `upstream_error` |
| 529 | true | by config | **503** + `overloaded_error` |
| 其它 4xx | false | by config | 502 + `upstream_error` |

> `by config` 指账号绑定的 `ErrorCodeHandling` 配置（`account.ShouldHandleErrorCode`），即用户可以白名单某些错误码不参与重试。

### 1.2 Failover 分支（401 / 403 / 429 / 529 / 5xx）

代码位置：`gateway_service.go:5149`

```go
if resp.StatusCode >= 400 && s.shouldFailoverUpstreamError(resp.StatusCode) {
    // 1. 限流 / 状态打点
    s.handleFailoverSideEffects(ctx, resp, account)
    // 2. Ops 日志
    appendOpsUpstreamError(c, OpsUpstreamErrorEvent{...})
    // 3. 抛 UpstreamFailoverError，触发上层换账号重试
    return nil, &UpstreamFailoverError{
        StatusCode:             resp.StatusCode,
        ResponseBody:           respBody,
        RetryableOnSameAccount: account.IsPoolMode() && isPoolModeRetryableStatus(resp.StatusCode),
    }
}
```

Failover 行为说明：

1. **限流副作用**：429 / 5xx 会在 `RateLimitService` 里把当前账号"冷却"一段时间（指数退避），下次调度时跳过它。
2. **账号切换**：抛出的 `UpstreamFailoverError` 会被外层 `Forward` 循环捕获，再从同一个账号组里 pick 下一个可用账号重试（默认最多 `maxRetryAttempts=5` 次，总时长 `maxRetryElapsed=10s`）。
3. **重试耗尽**：所有账号都失败之后，走 `handleRetryExhaustedError`（`gateway_service.go:7120`），把最后一次上游响应翻译成 Sub2API 自定义的客户端错误码（见下方"客户端看到的错误码"小节）。

### 1.3 非 failover 分支（400 / 404 / 408 / 其它 4xx）

代码位置：`gateway_service.go:6949 handleErrorResponse`

不切账号，不重试，直接把上游错误翻译成对客户端的响应：

```go
switch resp.StatusCode {
case 400:
    // 400 比较特殊：原样透传上游响应体
    c.Data(http.StatusBadRequest, "application/json", body)
case 401:
    statusCode, errType, errMsg = 502, "upstream_error", "Upstream authentication failed..."
case 403:
    statusCode, errType, errMsg = 502, "upstream_error", "Upstream access forbidden..."
case 429:
    statusCode, errType, errMsg = 429, "rate_limit_error", "Upstream rate limit exceeded..."
case 529:
    statusCode, errType, errMsg = 503, "overloaded_error", "Upstream service overloaded..."
case 500, 502, 503, 504:
    statusCode, errType, errMsg = 502, "upstream_error", "Upstream service temporarily unavailable"
default:
    statusCode, errType, errMsg = 502, "upstream_error", "Upstream request failed"
}
```

注意：**这条分支只在 failover 之后 retry 耗尽时才被进入**，单条请求里普通客户端基本走不到这条分支的 401/403/429/529，因为它们已经被 failover 拦截了。**例外是 400**：400 不参与 failover，会走这里原样把上游 body 透传给客户端。

### 1.4 Pool 模式特殊行为

当账号工作在 Pool 模式（多个 token 复用一个账号资源）时，`isPoolModeRetryableStatus` 决定哪些错误码可以在**同一个账号**内换 token 重试，避免立刻把账号标记为不可用。这是上游 token 池场景的优化。

### 1.5 Anthropic API Key Passthrough 路径

`forwardAnthropicAPIKeyPassthroughWithInput`（`gateway_service.go:5028`）是 Sub2API 把请求**完整透传**给上游 Anthropic 的链路（包括 `x-api-key` 注入、SSE 字节级转发）。即便如此，它依然复用上面同一套 `shouldFailoverUpstreamError` 判断，**不会跳过 failover 逻辑**。这是当前 `cliproxy` 账号继承的行为。

### 1.6 客户端看到的最终错误码

* 上游 200/响应体内 error：原样
* 上游 400：状态码 + body 全部透传给客户端
* 上游 401 / 403：客户端看到 **502 upstream_error**
* 上游 429：客户端看到 **429 rate_limit_error**（保留原始状态码）
* 上游 529：客户端看到 **503 overloaded_error**
* 上游 5xx：客户端看到 **502 upstream_error**

也就是说：Sub2API 把 401/403 这种"账号侧"的错误**藏起来**了，对客户端表现为 502。这是有意为之，避免把上游账号的鉴权信息透露给最终用户。

### 1.7 错误透传规则（Error Passthrough Rule）

`applyErrorPassthroughRule`（被 `handleErrorResponse` 调用）允许管理员通过配置匹配特定的上游错误响应（按状态码 + body 关键词），强制按规则中指定的状态码 / 类型透传给客户端。这是给运维"特殊场景下原样透传"的逃生口。在普通流量里默认不启用。

---

## 2. CLIProxyAPI 的错误码处理

CLIProxyAPI 自己也是个网关，它从 Anthropic 官方拿响应、再返回给它的下游（也就是 Sub2API）。它有两个独立的错误处理层：

### 2.1 Executor 层：上游 → `statusErr`

`internal/runtime/executor/claude_executor.go:235`：

```go
if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
    // 读取并保留上游响应体
    err = statusErr{code: httpResp.StatusCode, msg: string(b)}
    return resp, err
}
```

无论是 401 / 403 / 429 / 5xx，executor 都把它**包成 `statusErr{code, msg}`** 抛回 SDK 层。SDK 层据此决定是否冷却该账号、是否换账号重试。

### 2.2 SDK 层：账号冷却与重试

`sdk/cliproxy/auth/conductor.go:2806` 和 `:2346` 是两个状态机分支（auth-level 与 model-level）：

| 上游状态码 | NextRetryAfter（默认冷却时长） | 副作用 |
|---|---|---|
| 401 | 30 分钟 | 标记 token 失效 |
| 402 / 403 | 30 分钟 | `payment_required` |
| 404 | 12 小时 | `not_found`（并 suspend model） |
| 408 / 500 / 502 / 503 / 504 | 1 分钟 | 视为瞬时错误 |
| 429 | 指数退避 / `Retry-After` header / `quota` 状态 | `quota` 进入 `Exceeded`，suspend model |
| 其它 | 不冷却 | 仅打点 |

`shouldRetryAfterError`（`conductor.go:2209`）控制是否在 SDK 层内自动重试：

```go
if status != http.StatusTooManyRequests {
    return 0, false      // 仅 429 才考虑 retry
}
if !m.retryAllowed(...) {
    return 0, false
}
retryAfter := retryAfterFromError(err)
if retryAfter == nil || *retryAfter <= 0 || *retryAfter > maxWait {
    return 0, false
}
return *retryAfter, true
```

也就是说，CLIProxyAPI **自身只会针对 429 + 有效 `Retry-After` 自动重试**，401/403/5xx 不会重试（账号会被冷却，但请求当场失败）。

### 2.3 HTTP Handler 层：错误回写客户端

`sdk/api/handlers/claude/code_handlers.go:369 WriteErrorResponse`：

```go
status := http.StatusInternalServerError
if msg != nil && msg.StatusCode > 0 {
    status = msg.StatusCode      // 上游状态码原样
}
// ... addon 头透传（passthrough_headers 开关）
body, _ := json.Marshal(h.toClaudeError(msg))
c.Status(status)
_, _ = c.Writer.Write(body)
```

`toClaudeError` 会按上游 status 翻译成 Anthropic 风格的 `{"type":"error","error":{"type":"...","message":"..."}}`，其中 `type` 字段大致按 HTTP 含义映射（如 `rate_limit_error`、`authentication_error`、`overloaded_error`），message 是 executor 抓回来的上游 body。

### 2.4 客户端（Sub2API 视角）看到的 CLIProxyAPI 错误

| 上游 Anthropic 返回 | CLIProxyAPI 是否换账号 | CLIProxyAPI 是否自动重试 | CLIProxyAPI 返回给下游的 HTTP 状态 |
|---|---|---|---|
| 401 | 是（冷却 30 min） | 否 | **401** |
| 403 | 是（冷却 30 min） | 否 | **403** |
| 404 | 是（冷却 12h + suspend model） | 否 | **404** |
| 408 | 是（冷却 1 min） | 否 | **408** |
| 429 | 是（指数退避） | **仅当带 Retry-After 时** | **429** |
| 500/502/503/504 | 是（冷却 1 min） | 否 | 原样 5xx |
| 529 | 不在分支中（走 default） | 否 | **529** |

关键差异点：**CLIProxyAPI 默认就保留了上游的 HTTP 状态码**（除非 internal panic 之类）。它的"账号冷却 / 换账号"逻辑是在 manager 层完成的，对下游不感知。

---

## 3. 两者对比与决策建议

### 3.1 关键差异

| 维度 | Sub2API | CLIProxyAPI |
|---|---|---|
| 何时换账号 | 401/403/429/529/5xx | 401/403/404/408/429/5xx |
| 单请求内换账号 | 是（同 group 内 pick next） | 是（同 manager 内 pick next） |
| 自动重试 401 | 否（但换账号） | 否 |
| 自动重试 429 | 仅靠"换账号"实现 | 自身会在 Retry-After 范围内重试 |
| 上游状态码透传 | 不透传 4xx（401/403 → 502；429 保留；5xx → 502/503） | 默认透传 |
| 上游响应体透传 | 仅 400 透传 | 默认透传（带 type/message 转换） |

### 3.2 当前 `cliproxy` AccountType 的实际行为

`cliproxy` 在 Sub2API 里继承了 `forwardAnthropicAPIKeyPassthroughWithInput` 的链路，也就是说：

1. CLIProxyAPI 已经做了自己的"换账号 + 冷却"，请求到达 Sub2API 的时候，要么成功要么是 CLIProxyAPI 重试耗尽后给出的最终错误码。
2. Sub2API 拿到这个错误码再走自己的 failover：
   * 401 → 把 cliproxy 账号本身打入冷却（这往往是误判，因为是 CLIProxyAPI 的内部账号失效，不是 Sub2API 这个"cliproxy 入口账号"的问题）
   * 429 → 把 cliproxy 账号打入冷却（这也可能是误判，因为是 CLIProxyAPI 后面所有 OAuth 都 429 了，但用户的 Sub2API key 没有问题）
   * 5xx → 类似

也就是说，**双层 failover 会带来语义错配**：CLIProxyAPI 已经穷尽尝试给出 429 了，Sub2API 又会基于这个 429 把"整个 cliproxy 入口账号"冷却，等于一个 cliproxy 上游短暂 quota 不足会导致 Sub2API 整体停用这个入口。

### 3.3 三种可选策略

**策略 A：维持现状（cliproxy 参与 Sub2API failover）**

* 适用：管理员配置了多个独立的 CLIProxyAPI 实例作为多个 cliproxy 账号，希望 Sub2API 在 CLIProxyAPI-1 全 quota 时切到 CLIProxyAPI-2。
* 缺点：单 CLIProxyAPI 实例场景下，会出现"账号永久冷却 → 实际请求都失败"的体感。

**策略 B：cliproxy 完全 bypass failover，错误码完全透传**

* 适用：CLIProxyAPI 自己就够稳定，Sub2API 只做协议透传。
* 实现：为 `AccountTypeCLIProxy` 特化 `shouldFailoverUpstreamError`（返回 false）+ 改写 `handleErrorResponse` 让 4xx 原样透传。
* 缺点：401 这种"CLIProxyAPI 拒收 Sub2API 的 key"也会原样吐给客户端，泄漏一点点上游身份信息。

**策略 C：仅对 5xx 和 502/503/504 做 failover，4xx 透传**

* 适用：希望 CLIProxyAPI 自己处理鉴权和限流（cliproxy 内的多账号已经做了 cooldown），Sub2API 只在 CLIProxyAPI 进程整体挂掉时切下一个 CLIProxyAPI 实例。
* 实现：对 `IsCLIProxy()` 账号，把 401/403/429/529 从 failover 集合里剔除（只保留 5xx）。
* 推荐：单 CLIProxyAPI 实例和多 CLIProxyAPI 实例都不会被误冷却，且仍然有进程级 failover。

### 3.4 我的倾向

短期（先跑通流程）：**策略 A 不动**，因为多 cliproxy 账号场景的语义是合理的，单实例场景出错时用户也能直接看 ops 日志。

中期：等真有用户反馈 401/429 误冷却问题再切到**策略 C**。这条路径改动小（只需要在 `shouldFailoverUpstreamError` 里加一段 `if account.IsCLIProxy() { ... }`），且能保留进程级 failover。

不推荐策略 B：完整透传 4xx 反而把 CLIProxyAPI 的 OAuth 细节透传给客户端，对运维不友好。

---

## 4. 代码位置索引

| 主题 | 位置 |
|---|---|
| Sub2API failover 判定 | `worktrees/v2/backend/internal/service/gateway_service.go:3822` |
| Sub2API API Key Passthrough 错误分支 | `worktrees/v2/backend/internal/service/gateway_service.go:5149` |
| Sub2API 客户端错误响应翻译 | `worktrees/v2/backend/internal/service/gateway_service.go:7046` |
| Sub2API retry 耗尽逻辑 | `worktrees/v2/backend/internal/service/gateway_service.go:7120` |
| Sub2API 错误透传规则 | `worktrees/v2/backend/internal/service/gateway_service.go:7015` |
| CLIProxyAPI executor 错误包装 | `third_party/CLIProxyAPI/internal/runtime/executor/claude_executor.go:235` |
| CLIProxyAPI manager 冷却策略 | `third_party/CLIProxyAPI/sdk/cliproxy/auth/conductor.go:2806` |
| CLIProxyAPI manager 重试判定 | `third_party/CLIProxyAPI/sdk/cliproxy/auth/conductor.go:2209` |
| CLIProxyAPI handler 错误响应 | `third_party/CLIProxyAPI/sdk/api/handlers/claude/code_handlers.go:369` |
