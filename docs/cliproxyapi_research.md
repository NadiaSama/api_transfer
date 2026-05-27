# CLIProxyAPI 调研：用量限制、Login 原理、模型列表

> 仓库快照：`third_party/CLIProxyAPI`，最新提交 `50d19e20`（README 赞助说明）。
> 与本文相关的更底层细节（请求头、Tool 重映射、CCH 签名、SSE 处理等）已在
> [`cliproxyapi-claude-analysis.md`](./cliproxyapi-claude-analysis.md) 中分析，本篇
> 只回答 `prompts/004.md` 的三个具体问题，避免重复。

---

## 一、用量限制：CLIProxyAPI 能不能复刻 Claude 订阅的 5h / 7d 限制？

**结论：不能开箱即用。** CLIProxyAPI 既不解析 Claude 订阅的「5 小时 / 7 天」配额头，
也没有任何 per-account / per-key 的「N tokens in M hours」配置项。它只有「上游
返回 429 之后做指数退避」这种被动机制。要做主动配额，必须自己写中间件。

### 1.1 它能感知到什么

| 上游信号 | 是否解析 | 位置 |
|---------|---------|------|
| `Retry-After`（秒） | ✅ | `internal/auth/claude/anthropic_auth.go:89-100` |
| `Retry-After-Ms`（毫秒） | ✅ | `internal/auth/claude/anthropic_auth.go:101-106` |
| HTTP 429 状态码 | ✅ 进入 cooldown 分支 | `sdk/cliproxy/auth/conductor.go:2346-2371` |
| `anthropic-ratelimit-unified-5h-*` | ❌ 未搜索到引用 | — |
| `anthropic-ratelimit-unified-7d-*` | ❌ | — |
| `oauth_limit` / 订阅 reset_at 业务字段 | ❌ | — |

也就是说，它把所有 429 当成「等一会儿再试」，并不知道这次 429 是 5 小时窗口还是
7 天窗口触发的；也不知道距离 reset 还有多久（除非上游主动给 `Retry-After`）。

### 1.2 它对 429 做了什么

`conductor.go:2346-2371` 的分支：

1. 把该 auth 标记 `QuotaState.Exceeded = true`、`Reason = "quota"`；
2. 计算 `NextRecoverAt`：优先用上游 `Retry-After`，否则走自己的指数退避
   （`nextQuotaCooldown`，1s → 2s → 4s → … 上限约 30 分钟）；
3. 设置 `BackoffLevel`，下一次失败会更长；
4. 把账号从可路由列表里临时摘掉，让 round-robin 切到下一个 auth；
5. 退避时长会通过 `Retry-After` 响应头透传给客户端（`sdk/cliproxy/auth/selector.go:105-114`）。

如果 `disable-cooling: true`（`config.example.yaml:74-111`），则跳过摘除，把 429
直接抛回给客户端。

### 1.3 它能跟踪到的「最近用量」

只有一个非常有限的滑动窗口：

- `sdk/cliproxy/auth/types.go:103-122` —— **20 个桶 × 10 分钟 = 约 200 分钟**
  （≈ 3.3 小时）的请求计数环；
- 只记录 **成功/失败次数**，不记录 token 数；
- 用途是 `GET /v0/management/api-key-usage` 之类的观测接口，**不参与放行决策**。

→ 这个窗口连 5 小时都覆盖不到，更别提 7 天。

### 1.4 配置层面有什么「quota」相关项

`internal/config/config.go:77-93` 加 `config.example.yaml:74-111` 给出的开关：

```yaml
disable-cooling: false            # 关掉 429 自动 cooldown
quota-exceeded:
  switch-project: true            # Gemini：换 GCP project
  switch-preview-model: true      # 自动降级到 preview 模型
  antigravity-credits: true       # 用 Google One AI credits 兜底
```

这些**都是「触发 quota 后怎么换」，不是「我自己设个上限」**。

管理端的 quota 类端点也只暴露了上面这几个开关：
`internal/api/handlers/management/quota.go` 的
`GET/PUT /v0/management/quota-exceeded/switch-project` 与 `…/switch-preview-model`。

`api-keys:` 在 `internal/config/sdk_config.go:34-35` 是一个**纯字符串数组**，没有
任何字段挂限额。

### 1.5 想达到「Claude 订阅 5h/7d 限制」的最小改造

CLIProxyAPI 不会给你这个能力，要靠外层：

1. 订阅消耗 token 数，可以从 `internal/api/handlers/management/usage.go` 的
   `GET /v0/management/usage-queue?count=N` 轮询消费（流式弹出，**消费一次就没了**，
   所以要么自己累计要么改成只读快照）。
2. 自己维护「每个 Claude 账号近 5 小时 token 总数」和「近 7 天 token 总数」。
3. 超限时调管理 API 把该 auth 标记 disabled，或者在你自己的网关层先于
   CLIProxyAPI 拒绝请求。

如果是要纳入 Sub2API 体系，参考已有的
[`cliproxyapi-integration-plan.md`](./cliproxyapi-integration-plan.md) 与
[`sub2api-billing.md`](./sub2api-billing.md)：把 5h/7d 配额放在 Sub2API 计费侧做，
CLIProxyAPI 只当一个无状态出口。

---

## 二、`claude login` 的工作原理：是不是「伪装成 Claude Code 客户端」？

**结论：在 OAuth 授权这一步，它确实就是「以 Claude Code 客户端的身份」拿 token，
但不是靠伪造请求头做的伪装——而是直接复用了 Claude Code CLI 的官方 OAuth
注册（client_id 一模一样）。真正的「伪装」发生在后面调 `/v1/messages` 时。**

### 2.1 OAuth 注册参数

`internal/auth/claude/anthropic_auth.go:23-32`：

```go
const (
    AuthURL     = "https://claude.ai/oauth/authorize"
    TokenURL    = "https://api.anthropic.com/v1/oauth/token"
    ClientID    = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    RedirectURI = "http://localhost:54545/callback"
)
```

- `client_id` `9d1c250a-…` 就是 Anthropic 官方 Claude Code CLI 的客户端 ID（公开
  常量，社区里多个第三方实现都用同一个）；CLIProxyAPI 并没有注册自己的 OAuth 应用。
- `scope`（`anthropic_auth.go:200` 附近）：
  `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
  ——和 Claude Code CLI 申请的 scope 集一致，包含 `user:sessions:claude_code`，
  这是订阅订阅级 inference 权限的关键 scope。
- PKCE：`S256`，32 字节随机 verifier。

从 Anthropic 授权服务器视角，这次 OAuth 请求与官方 Claude Code CLI 不可区分：同一
个 `client_id`、同一组 scope、同样的 PKCE。所以拿到的 token 也就是「Claude Code
订阅级 OAuth token」，token 前缀 `sk-ant-oat...`。

### 2.2 用户视角的步骤

入口：`internal/cmd/anthropic_login.go` → `DoClaudeLogin()`，背后调用
`sdk/auth/claude.go`：

1. 生成 PKCE verifier/challenge 和随机 `state`（`sdk/auth/claude.go:54-62`）。
2. 启动本地回调服务器，监听 `127.0.0.1:54545`，路由 `/callback` 与 `/success`
   （`internal/auth/claude/oauth_server.go:22-108`），端口可用 `--oauth-callback-port` 覆盖。
3. 自动打开浏览器到 `https://claude.ai/oauth/authorize?...`
   （`sdk/auth/claude.go:88-96`），如带 `--no-browser` 则只打印 URL。
4. 用户在 claude.ai 登录、同意授权，浏览器被 302 到
   `http://localhost:54545/callback?code=...&state=...`，本地服务器在
   `oauth_server.go:168-223` 抓到 code。
5. 远程或 SSH 场景下无法自动回调时，等 15 秒后允许用户手工粘贴整个 callback
   URL（`sdk/auth/claude.go:122-155`）。
6. 用 `code + verifier` POST 到 `https://api.anthropic.com/v1/oauth/token`
   （`anthropic_auth.go:269-275`），换出 `access_token` + `refresh_token`。

### 2.3 Local OAuth Callback：54545 端口在做什么

`claude login` 启动时通常会打印一句「The local OAuth callback uses port 54545」。
这个本机 HTTP 服务是整条 OAuth 流程能跑通的关键，理解它有助于排查 SSH 远程 / 端口
冲突等异常场景。

#### 它存在的原因

授权服务器（claude.ai）颁发的 authorization code 必须通过 HTTP 重定向送回应用，
但 CLI 没有公网域名，浏览器没法直接送给 CLI 进程。解决办法：CLI **临时在本机开一个
HTTP 服务器**作为「收件窗口」，把地址告诉 claude.ai：
`http://localhost:54545/callback`。claude.ai 让浏览器跑一趟把 code 送过来，CLI
收完即关。

#### 完整时序

```
你的 CLI                      浏览器                      claude.ai
  │
  │  1. 起本地 HTTP 服务监听 127.0.0.1:54545
  │     (oauth_server.go:22-108)
  │
  │  2. 拼接授权 URL，含
  │     redirect_uri=http://localhost:54545/callback
  │  ────────► 自动开 ────────►
  │                              │  3. 用户登录、点"允许"
  │                              │  ──────────────────────►
  │                              │                              │
  │                              │  4. 302 重定向 ◄────────────
  │                              │     Location:
  │                              │     localhost:54545/callback
  │                              │     ?code=...&state=...
  │                              │
  │  ◄──── 5. 浏览器访问 ────────┘
  │     /callback?code=...
  │
  │  6. 抓到 code (oauth_server.go:168-223)
  │     返回成功 HTML 页给浏览器
  │
  │  7. 关闭本地 HTTP 服务
  │
  │  8. 拿 code + PKCE verifier POST 到
  │     /v1/oauth/token ─────────────────────────────────────►
  │  ◄──── access_token + refresh_token ──────────────────────
```

关键：**code 是通过浏览器从 claude.ai 流到 CLI 的**——授权服务器自己不直连 CLI。

#### 为什么必须是 `localhost:54545`

| 约束 | 原因 |
|------|------|
| 端口固定 54545 | Anthropic 在 Claude Code OAuth App 上登记的 `redirect_uri` 就是这个；授权服务器只把 code 重定向到**完全一致**的地址，多一字符都不行。CLIProxyAPI 复用了 Claude Code 的 `client_id`，所以也只能用 54545 |
| 必须 `localhost`（http 也行） | 通常 `redirect_uri` 要走 HTTPS；[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) 对 native app 例外允许 `http://localhost:*`，因为到 127.0.0.1 的流量不出本机，无中间人风险 |
| 即便有恶意进程抢 54545 偷到 code | 也换不出 token——PKCE 要求换 token 时带上 `code_verifier`，verifier 只在原 CLI 进程的内存里 |

#### 实操场景速查

| 场景 | 行为 |
|------|------|
| 本机带 GUI | 自动开浏览器 → 登录 → 自动回调；全程零粘贴 |
| `--no-browser` 在本机 | CLI 只打印 URL，自己拷到浏览器打开；浏览器仍能访问本机 54545 |
| SSH 远程服务器，本地无 GUI | 远程 54545 浏览器够不着；等 15 秒后**降级到手动模式**（`sdk/auth/claude.go:122-155`），在本地浏览器登录后把地址栏里完整的 `http://localhost:54545/callback?code=...&state=...` 粘回 SSH 终端，CLI 从字符串里解析 code |
| 上面更优雅的方案 | SSH 端口转发：`ssh -L 54545:localhost:54545 user@host` 把远程 54545 映射回本地，退化成 GUI 场景 |
| 54545 被占 | bind 失败；项目有 `--oauth-callback-port` 参数，**但对 Claude 无效**（Anthropic 那边只认 54545），只能先释放占用进程 |

### 2.4 OAuth POST 本身的「伪装面」

值得注意：**这一次 token-exchange 的 POST，请求头反而非常素**：

- 只有 `Content-Type: application/json`、`Accept: application/json`；
- 没有 `x-app`、`anthropic-beta`、`x-stainless-*`、`User-Agent` 也是默认 Go；
- 但 HTTP 客户端走的是 **uTLS + Chrome 指纹**
  （`internal/runtime/transport/utls_transport.go:108` 附近），用来绕开 Cloudflare 的
  Bot 检测——这是 TLS 层的伪装，不是 HTTP 头层的。

真正大量「伪装成 Claude Code CLI」的请求头（`X-App: cli`、`User-Agent: claude-cli/...`、
`X-Claude-Code-Session-Id`、`X-Stainless-*`、`anthropic-beta: claude-code-…`、
Tool 名大写重映射、CCH 签名等）是发生在**后面调用 `/v1/messages`** 的时候，详见
[`cliproxyapi-claude-analysis.md`](./cliproxyapi-claude-analysis.md) 的 A.2 节。

### 2.5 凭据落盘

`sdk/auth/claude.go:203` + `internal/auth/claude/token.go:18-89`：

- 路径：`<auths-dir>/claude-<email>.json`，默认 `auths-dir` 是 `./auths/`，可配置。
- 文件权限：`0700`。
- 结构 `ClaudeTokenStorage`：`AccessToken / RefreshToken / Email / Expire / Type:"claude" / LastRefresh`。

刷新时复用相同 `client_id`，并发安全（singleflight，见 `anthropic_auth.go:34-37`），
失败重试有 5s–5m 的指数退避（`anthropic_auth.go:30-31`）。

### 2.6 一句话总结

> 「伪装」分两层：**OAuth 这一层是「使用 Claude Code 的官方 OAuth 应用注册」，
> 拿到的就是真正的 Claude Code 订阅 token；后面调用 `/v1/messages` 这一层才会
> 真正在 HTTP 头、TLS 指纹、Tool 名上全方位模拟 Claude Code CLI。**

### 2.7 两层伪装的强度差异：为什么 `/v1/messages` 层「必须做、长期要维护」

为什么不在 Login 一次性把身份伪造好就完事？因为 Anthropic 不只在发卡（OAuth）时
认身份，**每次刷卡（`/v1/messages`）也要认**。订阅 token 是 5 折票，他们要确保
持票人在用官方 Claude Code，而不是把订阅当成 API 批量转卖。

可类比为：

- **Login = 办会员卡**：Anthropic 只看你报的 `client_id` 是不是 `9d1c250a-…`
  （Claude Code 的官方 OAuth App ID）。CLIProxyAPI 直接复用这个 ID，柜台不会
  按 User-Agent 查发卡人，所以 OAuth POST 的请求头几乎是空的，足够通过。
- **`/v1/messages` = 每次刷卡点餐**：服务端会反复确认「这次刷卡的人是不是真在用
  Claude Code CLI」。一旦特征不像，就触发风控（429 / 403 / 账号标记）。

所以 `applyClaudeHeaders`（`claude_executor.go:917-1027`）+ Tool 名 TitleCase
重映射 + CCH 签名（`signAnthropicMessagesBody`）+ uTLS Chrome 指纹这一整套，
**必须每个请求都做对**，否则订阅 token 会被识别为「非 Claude Code 客户端在用
Claude Code 票」。

### 2.8 这种伪装能撑多久：Anthropic 反检测的非对称性

调研时绕不开的一个问题——「Anthropic 升级指纹检查，是不是会把官方老版 Claude Code
用户也一起误伤？」是的，这正是 CLIProxyAPI 这类工具能持续存在的根本原因。

#### 2.8.1 Anthropic 强制不动的事

- 大量企业 / IDE 集成会**锁某个旧版 Claude Code**，停在某个版本好几个月很常见；
  一刀切「只接受最新 UA」会引爆客服工单。
- 因此能强制的边界是「**兼容窗口**」而不是「最新版」。
- **静态请求头层**（`User-Agent`、`X-Stainless-*`、`anthropic-beta`、`X-App`）：
  旧官方客户端发的字节序列与 CLIProxyAPI 当前模拟出来的字节序列**完全一样**，
  服务端从字节层面区分不出二者。

→ 这一层 Anthropic 收不紧，是 CLIProxyAPI 长期能跑的基础。

#### 2.8.2 Anthropic 还有的「非对称」武器

| 武器 | 工作原理 | 对第三方代理的杀伤力 |
|------|---------|---------------------|
| **已知版本白名单** | 不再只校验 `claude-cli/X.Y.Z` 格式，而是检查 `X.Y.Z` 是否在 Anthropic 自己的发版记录里 | 中等：CLIProxyAPI 必须跟着官方真实发版号走，需要持续 commit 更新（看 `applyClaudeHeaders` 的 commit 频次就能感觉到） |
| **CCH 请求体签名 + 密钥轮换** | 客户端用嵌在二进制里的密钥/算法对消息体签名（`signAnthropicMessagesBody`），服务端验签；可以定期换密钥并给老版本 grace period | 高：每次密钥/算法变了就要重新逆向官方 Node 包；只在 OAuth 路径（`sk-ant-oat...` 前缀）启用，进一步说明 Anthropic 想把"客户端身份"和"订阅授权"绑死 |
| **行为/用量指纹** | 看请求 QPS、token 消耗速率像不像真人在 IDE 里用；看 Tool 定义是否就是 Claude Code 自带 16 个 built-in；看会话生命周期模式 | 最高：与请求头无关，与"谁在用"有关。第三方代理一旦被很多 API 客户端共用，行为曲线就会偏离真实 CLI，无法靠头部伪装掩盖 |

CCH 签名值得展开：只要算法是确定性的、密钥静态，第三方就能从 Node 包里抠出来用，
这就是 CLIProxyAPI 在做的事；但 Anthropic 可以在新版客户端里换密钥，给老版一个
grace 期，过期后老官方版 + 全部第三方工具同时被淘汰。这是「Anthropic 换密钥
节奏 vs. 社区逆向速度」的赛跑。

#### 2.8.3 实际风险排序

按"什么最可能让你的订阅账号被废"排序：

1. **行为侧** —— 用量曲线像 API 而不是像 CLI（5h/7d 没节流的话特别明显）。
   这也是为什么 §1 说"CLIProxyAPI 自身没有 5h/7d 限制是真正要紧的问题"——
   不限流的话，你比 Anthropic 还更容易先把账号用废。
2. **CCH 签名层** —— 哪天 Anthropic 轮换签名/算法且社区没及时跟进，会一段时间
   401/403。
3. **请求头层** —— 受官方老版兼容窗口保护，短期内最不容易出问题。

#### 2.8.4 实操含义

- 把 CLIProxyAPI 接入 Sub2API（见 [`cliproxyapi-integration-plan.md`](./cliproxyapi-integration-plan.md)）
  时，**5h/7d 限流必须在 Sub2API 计费侧实现**，不能指望 CLIProxyAPI 或 Anthropic
  保护你。这是 §1 结论的另一种表述。
- CLIProxyAPI 升级节奏要跟着 Claude Code 官方走（每次 Claude Code 发版后留意
  `applyClaudeHeaders` 是否有 PR）。锁老版有锁老版的风险（CCH 密钥过期）。
- OAuth `client_id` 本身是相对稳定的——只要 Anthropic 不重新注册 Claude Code 的
  OAuth App，Login 这一步几乎不会坏。

---

## 三、Claude Code 客户端连上 proxy 后，看到的模型列表是怎么来的？

**结论：模型列表来自一个进程内的 `GlobalModelRegistry`，由「当前已登录的 auth +
provider 默认表 + 配置覆盖」拼出来的；按客户端的 `User-Agent` 切换响应格式。
但是 Claude Code 实际上几乎用不到这个列表——它是直接把固定 model id 塞到
请求体里的，列表更多是「OpenAI / Gemini 等需要枚举模型的客户端」用的。**

### 3.1 路由层

`internal/api/server.go:380-418`：

- `GET /v1/models` → `s.unifiedModelsHandler(openaiHandlers, claudeCodeHandlers)`
- `GET /v1beta/models` → `s.geminiModelsHandler(...)`（Gemini）
- `GET /v1beta/models/*action` → `s.geminiGetHandler(...)`

`unifiedModelsHandler` 在 `server.go:855-869` 按 `User-Agent` 分发：

```go
userAgent := c.GetHeader("User-Agent")
if strings.HasPrefix(userAgent, "claude-cli") {
    claudeHandler.ClaudeModels(c)   // 输出 Anthropic 风格 JSON
} else {
    openaiHandler.OpenAIModels(c)   // 输出 OpenAI 风格 JSON
}
```

所以同一个 `/v1/models` 端点，Claude Code 与 OpenAI/任意 SDK 看到的是**同一份模型集
但不同的 JSON 结构**。

### 3.2 数据来源：内置 JSON + 远端刷新 + 用户配置三层

**先说重点：模型列表不是 Go 代码里的常量，而是一份 JSON 清单，由 CLIProxyAPI
项目维护者维护。** Anthropic OAuth 订阅这条路在上游根本不暴露 `/v1/models`，所以
CLIProxyAPI 只能自带一份默认表。

**层 1：编译期内置的 `models.json`（fallback）**

- 文件：`internal/registry/models/models.json`（当前 2351 行，含 `claude-haiku-4-5-20251001`、
  `claude-sonnet-4-5-20250929`、`claude-sonnet-4-6`、`claude-opus-4-*` 等，每条带
  `context_length` / `max_completion_tokens` / `thinking` 范围等元信息）。
- 通过 Go `//go:embed` 编译进二进制：`internal/registry/model_updater.go:27-28`。
- 进程启动时 `init()` 直接 `loadModelsFromBytes(embeddedModelsJSON, "embed")`
  （`model_updater.go:67-72`）。即便完全离线也能给出一份能用的清单。

**层 2：运行时从远端定期刷新**

`model_updater.go:18-25, 77-99`：

```go
var modelsURLs = []string{
    "https://raw.githubusercontent.com/router-for-me/models/refs/heads/main/models.json",
    "https://models.router-for.me/models.json",
}
const modelsRefreshInterval = 3 * time.Hour
```

- 启动时立刻拉一次（`tryStartupRefresh`），之后每 3 小时再拉一次（`periodicRefresh`），
  成功则原子替换内存里的 catalog 并触发 `ModelRefreshCallback`，把变更通知给已注册
  的 auth。
- 命令行加 `--local-model` 可以**完全关掉远程刷新**，永远只用 layer 1 的嵌入版。
- 这两个 URL 是 router-for-me（CLIProxyAPI 作者）自己维护的仓库，不是 Anthropic 的
  官方接口——也就是说默认情况下，你的进程在隐式信任作者发布的模型清单。

**层 3：每条 auth 注册时的过滤 / 用户覆盖**

`sdk/cliproxy/service.go` 的 `registerModelsForAuth()` 流程（行号见 `service.go:1047,
1091-1127` 附近）：

1. 从全局 catalog 拉对应 provider 的默认表：`registry.GetClaudeModels()`、
   `registry.GetGeminiModels()`、`registry.GetCodexModels()` 等，本质上都是返回
   layer 1/2 合并后的 `staticModelsJSON.Claude` 等字段的克隆
   （`internal/registry/model_definitions.go:32-90`）。
2. 如果 `config.yaml` 里某条 `claude-api-key` / `gemini-api-key` 配了
   `models: [...]`，就用用户配置整段覆盖默认表（`service.go:1092-1095, 1124-1127`）。
3. 调 `applyExcludedModels()`（`service.go:1100` 附近）剔掉「只在 API Key 模式可用、
   OAuth 不暴露」的模型。
4. 把最终结果通过 `GlobalModelRegistry().RegisterClient(authID, providerKey, models)`
   挂到这条 auth 上；这样不同 auth 可以挂不同模型集。

最后客户端调 `/v1/models` 时，handler 调 `registry.GetGlobalRegistry().GetAvailableModels("claude")`
取的就是「所有 Claude provider auth 注册过的模型并集」。

### 3.3 Claude Code 拿到的 JSON

`sdk/api/handlers/claude/code_handlers.go:133`（`ClaudeModels` 方法）：

```go
models := registry.GetGlobalRegistry().GetAvailableModels("claude")
// 字段重命名、组装为 Anthropic 风格响应
c.JSON(200, gin.H{
    "data":     models,
    "has_more": false,
    "first_id": firstID,
    "last_id":  lastID,
})
```

每个条目形如：

```json
{
  "id": "claude-opus-4",
  "object": "model",
  "owned_by": "anthropic",
  "display_name": "Claude Opus 4",
  "created_at": "..."
}
```

`id` 没有被改写——它就是上游 Anthropic 的官方 model id。`::thinking` 这种后缀**不会
出现在列表里**，因为它属于「请求时的 model 字段后缀」，由
`internal/thinking/suffix.go` 在转译阶段解析掉（参见
`cliproxyapi-claude-analysis.md` A.2 的「模型名映射」段）。

### 3.4 列表对 Claude Code 来说重要吗？

实际上不重要：

- Claude Code 客户端在调 `/v1/messages` 时是直接把硬编码的 model id（如
  `claude-opus-4`、`claude-sonnet-4-5`）放进 body 的，并不会先查 `/v1/models`
  来决定用哪个；
- 即使列表为空，只要请求里的 model id 在 registry 里有 auth 能服务它，就能正常
  执行；
- 反过来如果请求的 model id 在 registry 里完全没注册，会在「执行器选择」阶段
  报错而不是在 `/v1/models` 报错。

→ `/v1/models` 更多是给「会列模型 UI」（Open WebUI、各种通用网关）用的；Claude
Code 用它顶多是 IDE 内做下拉选择时的展示。

### 3.5 一句话总结

> 模型列表是**一份 JSON 清单**，编译期内置一份（`internal/registry/models/models.json`），
> 运行时每 3 小时从作者的 GitHub 拉新版覆盖（`--local-model` 可关），再叠加每条
> auth 的配置覆盖与 OAuth 排除规则。所有 auth 的并集通过 `/v1/models` 暴露，按
> `User-Agent` 切 Anthropic / OpenAI 风格 JSON。**Claude Code 客户端实际并不依赖
> 这个列表**——model id 是它自己写死塞进请求体的，proxy 直接透传到上游。

---

## 四、部署 Checklist：从 `config.example.yaml` 到能上生产

### 4.0 默认行为速记

- **配置文件路径**：没传 `--config` 时，从 `$PWD/config.yaml` 读（不是二进制目录、不是 `~/.cli-proxy-api`）。
  代码：`cmd/server/main.go:446-453`。
- **找不到 `config.yaml` 就直接退出**（普通模式 `LoadConfigOptional` 会报 `failed to load config`）。
  cloud-deploy 模式才会容忍缺文件，普通启动不会。
- **默认端口** = **模板里的 `port: 8317`**。代码层面没有"YAML 没填就 fallback 到 8317"的兜底，YAML 不填会拼成 `:0`（内核随机分配，实际不可用）。唯一硬编码 8317 的地方是 `-home-jwt` 模式。
- **默认绑定** = `host: ""` → `:8317` → 监听全部接口（v4 + v6 双栈）。
- **`.env`** 也是从 `$PWD` 加载（`main.go:167`）。
- **auth-dir 默认** = `~/.cli-proxy-api`（`util.ResolveAuthDir` + `config.DefaultAuthDir`）。`--claude-login` 拿到的 token 写成 `claude-<email>.json`，多账号同目录互不覆盖。

> 所以 `config.example.yaml` 本身就是设计成"开箱即用"的模板：`cp config.example.yaml config.yaml`
> 即可启动，但有几处**必改**和**Claude 专项**需要先调一遍。

### 4.1 必改项（不改会有安全 / 可用性问题）

| 字段 | 模板值 | 必须改的理由 |
|---|---|---|
| `api-keys`（L39-42） | `"your-api-key-1"` 等占位 | **这是客户端唯一的鉴权口**；原样部署 + 公网监听 = 开放代理。换成强随机串，无关条目删干净。 |
| `host`（L3） | `""`（= `0.0.0.0` 双栈） | 默认对公网开。仅本机/容器用 → `"127.0.0.1"`；对外暴露务必配反代 + 强 `api-keys`。 |
| `remote-management.secret-key`（L23） | `""` | 空 = Management API 完全关闭（`/v0/management/*` 返回 404）。**只在确实需要管理界面/接口时才设**；设了用强密钥（明文会在启动时 bcrypt 化）。 |

### 4.2 Claude 订阅（本项目核心场景）相关项

`--claude-login` 拿到的 OAuth token 不写在 YAML，落到 `auth-dir/claude-<email>.json`，所以**不需要**写 `claude-api-key`。Claude 相关开关：

| 字段 | 建议 |
|---|---|
| `auth-dir`（L36） | 默认 `~/.cli-proxy-api` 即可；容器 / systemd 专用账户下用绝对路径更清晰 |
| `claude-header-defaults`（L226-233，注释态） | **建议显式开启并定期跟着 Claude Code 升级**。这是冒充客户端的指纹基线（UA / package / runtime / os / arch）。开 `stabilize-device-profile: true` 可锁定每个 auth 的设备指纹，降低跨账号串味的风险——见 §2.8 反检测分析。 |
| `claude-api-key[].cloak`（L207-216） | 仅在用**直连 API key**（非 OAuth）时才有意义。OAuth 走的是 §2.4 / §2.7 描述的"全方位伪装"路径，不受这段控制。 |
| `routing.session-affinity`（L121） | **多账号场景强烈建议开**。开了之后同一会话固定命中同一账号，方便追踪单账号的 5h/7d 用量轨迹；不开就是 round-robin，每次请求可能换号，跟订阅限制的语义对不上。 |
| `max-retry-credentials`（L90） | 多账号建议设 2-3 的上限，避免一次失败把所有 cooldown 中的账号都拖一遍（详见 [[error-handling-sub2api-vs-cliproxyapi]]）。 |

### 4.3 按需调整（按部署环境挑）

| 字段 | 模板值 | 何时改 |
|---|---|---|
| `pprof.enable` / `pprof.addr`（L49-50） | `false` / `127.0.0.1:8316` | 排查性能时临时开；地址保持 `127.0.0.1`，**不要绑 0.0.0.0**（pprof 暴露在公网 = 内存 dump 任取） |
| `debug`（L45） | `false` | 调试开；生产关，避免日志含敏感字段 |
| `logging-to-file`（L56） | `false` | 容器/systemd 保持 false 走 stdout；裸跑可以开 |
| `logs-max-total-size-mb`（L60） | `0`（不清理） | 开了 `logging-to-file` 务必同时设上限（例如 1024） |
| `proxy-url`（L76） | `""` | 国内 / 受限网络访问 anthropic.com 必填 socks5/http；支持 per-credential 覆盖 |
| `request-retry` / `max-retry-interval`（L86/93） | 3 / 30 | 默认值合理，按需微调 |
| `quota-exceeded.switch-project` / `switch-preview-model`（L109-110） | true / true | 多账号 failover 行为，保持默认 |
| `disable-cooling`（L96） | false | **别动**；关掉后 429/quota 状态机失效，账号被打死了还会继续撞 |
| `usage-statistics-enabled`（L67） | false | 想看 Management API 的用量数据要开 |
| `ws-auth`（L126） | true | 别关 |
| `enable-gemini-cli-endpoint`（L130） | false | 不用 Gemini CLI 客户端就保持 false |

### 4.4 最小化"能跑 + 安全"起步 patch

只想本机跑通 Claude 订阅这条线的话，复制 `config.example.yaml` 为 `config.yaml`，做以下 4 处改动就够：

```yaml
host: "127.0.0.1"                     # 仅本机
api-keys:
  - "<生成一个 32 字节随机串>"         # 替换占位，多余条目删掉
remote-management:
  secret-key: ""                      # 不用管理 API 就留空
# 国内/需要代理时再加：
proxy-url: "socks5://127.0.0.1:1080"
```

剩下默认值不动 → 启动后监听 `127.0.0.1:8317`，跑一次 `--claude-login` 即可使用。

> **多账号 = 串行登录**：`RedirectURI = http://localhost:54545/callback` 在 `internal/auth/claude/anthropic_auth.go:28`
> 硬编码，无法并发跑两个 `--claude-login`（端口 54545 冲突，第二个直接 `ErrPortInUse` 退出）。正确做法是一个登录完
> （`defer` 关闭 OAuth server 释放端口）再起下一个，token 落盘后由同一个服务实例按 `routing.strategy` 共同调度。

### 4.5 `session-affinity` 工作原理与多终端行为

**核心概念：粘的是"会话（session）"，不是"终端 / 进程 / 机器"。**

#### Session ID 识别优先级

代码：`sdk/cliproxy/auth/selector.go:572-655`、正则 `_session_([a-f0-9-]+)$`（L432）。

| 优先级 | 来源 | 典型客户端 |
|---|---|---|
| 1 | `metadata.user_id` 里的 `_session_{uuid}` 后缀 或 JSON 内嵌 `session_id` 字段 | **Claude Code** |
| 2 | `X-Session-ID` 请求头 | 通用 |
| 3 | `Session_id` 请求头 | Codex |
| 4 | `X-Amp-Thread-Id` 请求头 | Amp CLI |
| 5 | `X-Client-Request-Id` 请求头 | PI |
| 6 | `metadata.user_id`（不带 session 后缀的原始值） | 兜底 |
| 7 | `conversation_id` 字段 | 通用 |
| 8 | 前几条 system + user + assistant 内容的稳定哈希 | 最后兜底（不可靠） |

> Claude Code 在**每个新会话**生成一个新的 session uuid（客户端内部行为，跟终端、进程、机器无关）。
> 同一会话内的所有请求共享同一 uuid。

#### 缓存与绑定（`selector.go:484-537`）

```
cacheKey = provider + "::" + sessionID + "::" + model
```

- 首次请求 cache miss → 走 fallback selector（默认 round-robin）选号 → 写入缓存。
- 后续同 session + 同 model cache hit → 锁定到同一账号。
- TTL 默认 1h（`session-affinity-ttl`，`builder.go:213`）；超时未活动则下次重选。
- 绑定的账号进入 cooldown / unavailable 时**自动重选并刷新缓存**（L508-514），不会卡死。
- cacheKey 含 model：**同一会话用不同 model 算两条独立绑定**（比如 sonnet 和 haiku 可能命中不同账号）。

#### 多终端行为速查（一台机器跑两个 claude）

| 场景 | 行为 |
|---|---|
| 两个终端各自启动新 claude 会话，1 个账号 | 都用这同一个账号（没得选） |
| 两个终端各自启动新 claude 会话，多个账号 + round-robin | 两个会话首请求大概率落在不同账号上，之后各自粘在自己账号 |
| 同一终端 `/clear` 重开会话 | 通常生成新 session uuid → 重新选号 |
| 同一终端持续同一会话 | 始终同号（除非 1h TTL 过期或账号 cooldown） |
| 非 Claude Code 客户端，没带 session 头 | 掉到优先级 8 的内容哈希，**不可靠** —— 多账号时强烈建议显式发 `X-Session-ID` |

#### 与 Claude 订阅 5h/7d 限制的配合

- **`session-affinity: true` + `strategy: round-robin`** 是黄金组合：新会话散开到不同账号，已有会话粘住不串味。
- **`session-affinity-ttl`** 默认 1h 偏短；想完整观察 5h/7d 用量轨迹，建议拉到 `"6h"` 甚至更长，避免中途换号造成统计断层。
- **不要开 `disable-cooling`**：cooldown 是 session-affinity 自动重选的依据，关了会一直撞 429。
- 想强制某客户端固定走某账号（调试用），让它发 `X-Session-ID: <固定串>` 即可。

> 这一节用于回答"多终端是否共享账号"——答案是**默认会被识别成两个独立 session 分别选号**，不是粘在同一个账号。
> 真正决定"是否同号"的是 fallback selector（round-robin / fill-first）和账号数量。

---

## 关键文件速查

| 主题 | 文件 | 行号 |
|------|------|------|
| OAuth 常量（client_id / scope / endpoints） | `internal/auth/claude/anthropic_auth.go` | 23-32 |
| Login 入口 / 本地回调服务器 | `internal/auth/claude/oauth_server.go` | 22-223 |
| Login 命令 | `internal/cmd/anthropic_login.go`、`sdk/auth/claude.go` | 全文 |
| Token 文件落盘 | `internal/auth/claude/token.go` | 18-89 |
| 429 / cooldown 决策 | `sdk/cliproxy/auth/conductor.go` | 2340-2371 |
| 最近请求滑动窗 (20×10min) | `sdk/cliproxy/auth/types.go` | 103-122 |
| `quota-exceeded` 配置 | `internal/config/config.go` / `config.example.yaml` | 77-93 / 74-111 |
| 管理 API：quota 开关 | `internal/api/handlers/management/quota.go` | 全文 |
| 管理 API：usage 队列 | `internal/api/handlers/management/usage.go` | 24-43 |
| `/v1/models` 路由 + UA 分发 | `internal/api/server.go` | 385, 855-869 |
| 模型注册表 | `internal/registry/model_registry.go` + `sdk/cliproxy/service.go` | `registerModelsForAuth` 附近 |
| 内置模型清单（`//go:embed`） | `internal/registry/models/models.json`、`internal/registry/model_updater.go` | json:全文 / updater:27-28, 67-72 |
| 远端模型刷新（router-for-me） | `internal/registry/model_updater.go` | 18-25, 77-99 |
| 默认表读取（合并嵌入+远端结果） | `internal/registry/model_definitions.go` | `GetClaudeModels` 等:32-90 |
| Claude 模型 JSON 输出 | `sdk/api/handlers/claude/code_handlers.go` | 133 |
| session-affinity 选择器 | `sdk/cliproxy/auth/selector.go` | 432, 484-537, 572-655 |
| session-affinity 配置装配 | `sdk/cliproxy/builder.go` | 212-238 |
