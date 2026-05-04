# Sub2API 后端架构分析

## 一、整体后端架构

### 1.1 技术栈

| 组件 | 技术选型 |
|------|----------|
| 语言 | Go 1.25 |
| Web 框架 | Gin-gonic |
| ORM | Ent (Entity framework) |
| 数据库 | PostgreSQL 15+ |
| 缓存 | Redis 7+ + go-cache (进程内缓存) |

### 1.2 项目目录结构

```
backend/
├── cmd/server/                    # 应用入口
├── internal/
│   ├── config/                    # 配置管理
│   ├── domain/constants.go        # 平台/账户类型常量定义
│   ├── handler/                   # HTTP 请求处理层
│   │   ├── gateway_handler.go     # Claude/Gemini/OpenAI 网关处理器
│   │   ├── openai_gateway_handler.go  # OpenAI 专用处理器
│   │   └── admin/                 # 管理后台处理器
│   ├── model/                     # 数据模型
│   ├── pkg/                       # 各提供商特定包
│   │   ├── claude/constants.go    # Claude 常量、模型列表、默认 Headers
│   │   ├── openai/                # OpenAI 相关
│   │   └── gemini/                # Gemini 相关
│   ├── repository/                # 数据访问层
│   ├── service/                   # 业务逻辑层 (核心)
│   │   ├── gateway_service.go     # 请求转发核心逻辑
│   │   ├── claude_token_provider.go   # Claude OAuth Token 管理
│   │   └── claude_code_validator.go   # Claude Code CLI 检测验证
│   ├── server/
│   │   ├── routes/gateway.go      # 路由注册
│   │   └── middleware/            # 中间件
│   └── web/                       # 前端资源
├── ent/                           # 数据库 Schema (Ent ORM 生成)
└── migrations/                    # 数据库迁移
```

### 1.3 支持的平台与账户类型

**平台 (Platform)** — 定义于 `internal/domain/constants.go`:

| 平台常量 | 说明 |
|----------|------|
| `anthropic` | Anthropic Claude |
| `openai` | OpenAI |
| `gemini` | Google Gemini |
| `antigravity` | 多模型聚合平台 |

**账户类型 (AccountType)** — 同文件:

| 类型 | 说明 |
|------|------|
| `oauth` | OAuth 全权限 (Claude 专用) |
| `setup-token` | Setup Token (仅推理) |
| `apikey` | API Key 认证 |
| `upstream` | 上游透传 |
| `bedrock` | AWS Bedrock |
| `service_account` | Google Service Account (Vertex AI) |

---

## 二、多提供商对接架构

### 2.1 核心设计模式：Provider Adapter + 路由分发

Sub2API 的核心设计是一个 **API 网关**，通过以下层次实现多提供商对接：

```
┌─────────────────────────────────────────────────────────────┐
│                      HTTP 请求入口                           │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              API Key 认证中间件 (Middleware)                  │
│              提取用户组 & 平台信息                            │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              路由分发 (routes/gateway.go)                     │
│     根据 API Key 所属组的 platform 字段分发                   │
│                                                             │
│   platform == "openai"  →  OpenAIGateway.Messages()         │
│   platform == "gemini"  →  GeminiMessagesCompat.Messages()  │
│   其他 (默认)           →  Gateway.Messages()  (Claude)     │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Handler 层 (gateway_handler.go)                  │
│     1. 解析请求体 & 模型                                     │
│     2. Claude Code CLI 检测                                  │
│     3. 并发控制 (用户级 + 账户级)                             │
│     4. 计费检查                                              │
│     5. 账户选择 (Sticky Session + 负载感知)                   │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Service 层 (gateway_service.go)                  │
│                                                             │
│  Forward() — 核心转发方法                                    │
│     1. 平台检测 & Beta 策略评估                              │
│     2. Claude Code 检测 → 非 CC 客户端触发 Mimicry           │
│     3. Model Mapping (模型 ID 映射)                          │
│     4. System Prompt 改写 (OAuth Mimicry 场景)               │
│     5. Metadata User ID 注入                                 │
│     6. buildUpstreamRequest() — 构建上游请求                  │
│     7. 发送请求 & 响应处理                                   │
│     8. 用量记录                                              │
└──────────────────────────┬──────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              上游 API 端点                                    │
│                                                             │
│   • https://api.anthropic.com/v1/messages    (Anthropic)    │
│   • https://api.openai.com/v1/...            (OpenAI)       │
│   • https://generativelanguage.googleapis.com (Gemini)      │
│   • Vertex AI endpoint                       (Service Acct) │
│   • AWS Bedrock endpoint                     (Bedrock)      │
│   • 自定义上游 URL                           (Upstream)     │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键代码位置

| 功能 | 文件 | 方法/位置 |
|------|------|-----------|
| 路由分发 | `internal/server/routes/gateway.go` | 根据 `getGroupPlatform(c)` 分发 |
| Handler 入口 | `internal/handler/gateway_handler.go` | `Messages()` |
| 核心转发 | `internal/service/gateway_service.go` | `Forward()` |
| 构建上游请求 | `internal/service/gateway_service.go` | `buildUpstreamRequest()` |
| 账户调度 | `internal/service/gateway_service.go` | Sticky Session + 优先级调度 |
| 用量记录 | `internal/service/gateway_service.go` | Token 级用量跟踪 |

### 2.3 账户调度机制

```
Account 模型:
  ├─ Platform: anthropic | openai | gemini | antigravity | bedrock
  ├─ Type: oauth | apikey | setup-token | service_account | bedrock | upstream
  ├─ Concurrency: 每账户并发上限
  ├─ Priority: 调度优先级 (数值越小优先级越高)
  ├─ Credentials: 对应提供商的认证信息
  └─ Extra: 自定义字段 (model_mapping, account_uuid 等)
```

特性：
- **Sticky Session**：基于 Hash 的会话绑定，防止跨请求上下文丢失 (TTL: 1小时)
- **负载感知**：根据并发使用情况动态选择账户
- **故障转移**：错误检测 + 自动换账户重试 (可配置最大切换次数)

---

## 三、Claude (Anthropic) 对接详解

### 3.1 是否支持直接对接 Anthropic 官方 API？

**是的，完全支持。** Sub2API 提供了对 Anthropic 官方 API 的全面、生产级集成，支持多种认证方式。

### 3.2 支持的 Claude 认证方式

#### A. OAuth 账户 (`AccountTypeOAuth`)

最完整的集成方式，支持 Claude Code 全功能。

- **认证方式**: `access_token` + `refresh_token` + `expires_at`
- **自动刷新**: 通过 `ClaudeTokenProvider` 自动管理 Token 生命周期
- **特殊处理**: User Metadata 归因、指纹标识、Billing Attribution

**核心文件**:
- `internal/service/claude_token_provider.go` — Token 缓存 & 自动刷新
  - `GetAccessToken()` — 获取有效 Token (自动刷新过期 Token)
  - 缓存 TTL: 30 分钟
  - 提前 3 分钟刷新 (skew)
  - 分布式刷新锁 (防止并发刷新)

**认证 Header 设置** (`gateway_service.go`):
```go
// OAuth 方式
setHeaderRaw(req.Header, "authorization", "Bearer "+token)
```

#### B. API Key 账户 (`AccountTypeAPIKey`)

直接使用 Anthropic 官方 API Key。

- **认证方式**: `api_key`
- **特性**: 支持自定义 Base URL、模型映射、配额跟踪 (日/周/总量)

**核心方法**: `forwardAnthropicAPIKeyPassthroughWithInput()` — API Key 透传

**认证 Header 设置**:
```go
// API Key 方式
setHeaderRaw(req.Header, "x-api-key", token)
```

#### C. Service Account / Vertex AI (`AccountTypeServiceAccount`)

通过 Google Vertex AI 访问 Claude 模型。

**核心方法**: `buildUpstreamRequestAnthropicVertex()` (`gateway_service.go`)
- 使用 Google Cloud 凭据进行签名
- 目标端点: `us-east5-aiplatform.googleapis.com` (可配置区域)
- 模型 ID 转换: `normalizeVertexAnthropicModelID()`

#### D. AWS Bedrock (`AccountTypeBedrock`)

通过 AWS Bedrock 访问 Claude 模型。

### 3.3 Claude Code 检测与伪装 (Mimicry)

**文件**: `internal/service/claude_code_validator.go`

Sub2API 实现了一套 Claude Code CLI 客户端检测机制：

**验证步骤** (`Validate()` 方法):
1. **User-Agent 检查** — 必须匹配 `claude-cli/\d+\.\d+\.\d+`
2. **System Prompt 相似度** — Dice coefficient 算法，阈值 0.5
3. **Header 验证** — 需要 `X-App`, `anthropic-beta`, `anthropic-version`
4. **Metadata User ID** — 验证格式

**Mimicry (伪装) 机制**:
对非 Claude Code 客户端使用 OAuth 账户时，系统会自动进行伪装：
- 替换 System Prompt 为 Claude Code 官方格式
- 注入 Billing Attribution Block
- 设置完整的 Claude Code Headers (User-Agent, X-Stainless-* 等)
- 管理 Beta Headers 对齐

### 3.4 Claude 相关常量与配置

**文件**: `internal/pkg/claude/constants.go`

**支持的 Beta 特性**:
```
oauth-2025-04-20
claude-code-20250219
interleaved-thinking-2025-05-14
fine-grained-tool-streaming-2025-05-14
token-counting-2024-11-01
prompt-caching-scope-2026-01-05
effort-2025-11-24
redact-thinking-2026-02-12
context-management-2025-06-27
extended-cache-ttl-2025-04-11
```

**支持的模型**:
- claude-opus-4-7
- claude-opus-4-6
- claude-opus-4-5-20251101
- claude-sonnet-4-6
- claude-sonnet-4-5-20250929
- claude-haiku-4-5-20251001

### 3.5 API 端点

| 端点 | 用途 |
|------|------|
| `POST /messages` | Messages API (主要对话接口) |
| `POST /messages/count_tokens` | Token 计数 |
| `GET /models` | 模型列表 |

上游目标 URL: `https://api.anthropic.com/v1/messages?beta=true`

---

## 四、总结

Sub2API 是一个**生产级 API 网关**，其核心价值在于：

1. **多提供商统一接入** — 通过路由分发 + 适配器模式，统一对接 Anthropic、OpenAI、Gemini、Bedrock 等
2. **多种认证方式** — 支持 OAuth、API Key、Service Account、Bedrock 等多种认证路径
3. **Claude Code 生态集成** — 检测官方 CLI、伪装第三方客户端、管理 OAuth Token 生命周期
4. **智能调度** — Sticky Session、优先级调度、故障转移、并发控制
5. **精细计费** — Token 级用量跟踪，多维度配额管理
