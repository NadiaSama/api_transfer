# Sub2API 计费 / 额度模块详细分析

**Git Commit**: `13d0ab4b` (feat: add billing_proxy account type with 8-layer request transform pipeline)

**文档生成时间**: 2026-05-21

---

## 一、计费维度与单位

### 1.1 计费维度：按 Token 数 + 缓存细分

sub2api 支持**按 Token 数计费**，并对 Claude 模型的缓存进行了细分：

| 维度 | 说明 | 存储字段 |
|------|------|--------|
| **Input Tokens** | 输入 token 数 | `input_tokens` |
| **Output Tokens** | 输出 token 数 | `output_tokens` |
| **Cache Creation Tokens** | 新缓存创建的 token 数 | `cache_creation_tokens` |
| **Cache Read Tokens** | 缓存读取的 token 数 | `cache_read_tokens` |
| **Cache 5m / 1h** | 缓存有效期分类（5分钟/1小时） | `cache_creation_5m_tokens`, `cache_creation_1h_tokens` |

**来源**: `backend/ent/schema/usage_log.go:67-79`

### 1.2 费率定义

#### A. 单位：USD（美元）

所有费率以**每百万 token 的美元价格**（per million tokens）定义，存储在 `ModelPricing` 结构体中：

```go
type ModelPricing struct {
    InputPricePerToken          float64  // 每 token 输入价格 (USD)
    OutputPricePerToken         float64  // 每 token 输出价格 (USD)
    CacheCreationPricePerToken  float64  // 缓存创建每 token 价格 (USD)
    CacheReadPricePerToken      float64  // 缓存读取每 token 价格 (USD)
    ...
}
```

**示例**（Haiku）: `InputPricePerToken = 1e-6` 表示 $1 per MTok（百万 token）

**来源**: `backend/internal/service/billing_service.go:45-60`

#### B. 模型费率来源（优先级）

1. **动态价格服务**（`PricingService`）— 从上游或外部 LiteLLM 格式配置加载
2. **硬编码回退价格** — 当动态加载失败时使用（见下表）

**硬编码价格示例**:

| 模型 | Input | Output | Cache Write | Cache Read |
|-----|-------|--------|------------|-----------|
| Claude Opus 4.7 | $5/MTok | $25/MTok | $6.25/MTok | $0.50/MTok |
| Claude Sonnet 4.6 | $3/MTok | $15/MTok | $3.75/MTok | $0.30/MTok |
| Claude Haiku 4.5 | $1/MTok | $5/MTok | $1.25/MTok | $0.10/MTok |
| GPT-5.4 | $2.5/MTok | $15/MTok | $2.5/MTok | $0.25/MTok |

**来源**: `backend/internal/service/billing_service.go:134-257`

#### C. Service Tier 倍率（可选）

支持按"优先级"（priority）/ "弹性"（flex）等 service tier 调整价格：

```go
func serviceTierCostMultiplier(serviceTier string) float64 {
    case "priority": return 2.0    // 优先级服务 2 倍价格
    case "flex":     return 0.5    // 弹性服务 5 折
    default:         return 1.0
}
```

**来源**: `backend/internal/service/billing_service.go:79-88`

### 1.3 是否支持多租户独立额度

**是的，完全支持**。Sub2API 实现了三层独立的额度/余额系统：

| 层级 | 实体 | 字段 | 含义 |
|-----|------|------|------|
| **用户层** | `User` | `balance` | 用户账户余额（USD） |
| **API Key 层** | `APIKey` | `quota`, `quota_used` | 该 API Key 的独立配额 |
| **账户层**（上游账号） | `Account` | `extra.quota_*` | 上游 API 账号的独立配额 |
| **订阅层** | `UserSubscription` | `daily_usage_usd`, `weekly_usage_usd`, `monthly_usage_usd` | 订阅制用户的周期用量 |

**来源**: 
- User: `backend/ent/schema/user.go:49-51`
- APIKey: `backend/ent/schema/api_key.go:63-89`
- UserSubscription: `backend/ent/schema/user_subscription.go:62-70`

---

## 二、扣费流程详解

### 2.1 流程概述

```
┌─────────────────────────────────────────────────────────────┐
│  请求到达 → Handler 层 (gateway_handler.go)                  │
└────────────────────┬────────────────────────────────────────┘
                     ▼
        ┌────────────────────────────────┐
        │  Forward() 方法 (gateway_service.go:4349)            │
        │  ├─ 鉴权 & 账户选择                 │
        │  ├─ 模型映射                     │
        │  ├─ System Prompt 改写            │
        │  └─ 构建上游请求                 │
        └────────────┬─────────────────────┘
                     ▼
        ┌────────────────────────────────┐
        │  buildUpstreamRequest()         │
        │  发送请求到上游 API              │
        └────────────┬─────────────────────┘
                     ▼
        ┌────────────────────────────────┐
        │  响应处理（流式/非流式）         │
        │  ├─ 解析 usage 字段             │
        │  ├─ 计算 cost (CalculateCostUnified)  │
        │  └─ 构造 UsageLog              │
        └────────────┬─────────────────────┘
                     ▼
        ┌────────────────────────────────┐
        │  applyUsageBilling()           │
        │  (原子事务扣费，見 2.2 节)      │
        └────────────────────────────────┘
```

**关键入口**:
- Handler: `backend/internal/handler/gateway_handler.go:Messages()`
- Forward: `backend/internal/service/gateway_service.go:4349`
- 扣费: `backend/internal/service/gateway_service.go:8089` (applyUsageBilling)

### 2.2 原子事务扣费（两段式）

Sub2API 采用**预扣 + 结算的两段式模型**，通过 PostgreSQL 事务保证原子性：

#### A. 预检（鉴权）阶段

**时机**：请求进入 handler，**转发上游前**

检查项（非完整拦截，仅作监控）：
- 用户是否禁用、API Key 是否过期
- 订阅是否有效（若使用订阅制）
- API Key 是否已触及 quota（仅记录警告，不拒绝）

**代码位置**: 无专门预检拦截函数（宽松模式：允许请求继续，由上游决策）

#### B. 实际扣费（后扣）

**时机**：收到上游响应，**解析 usage 后**

流程（`applyUsageBilling` @ `backend/internal/service/gateway_service.go:8089`）:

```
1. 解析 RequestID（客户端 ID → 本地 ID → 上游 ID → 生成新 ID）
   (resolveUsageBillingRequestID @ line:8002)

2. 构建 UsageBillingCommand（统一扣费指令）
   (buildUsageBillingCommand @ line:8032)
   ├─ RequestID：幂等性关键，防止重复扣费
   ├─ InputTokens / OutputTokens / CacheTokens：来自上游响应
   ├─ BalanceCost / SubscriptionCost / APIKeyQuotaCost：已计算的费用
   └─ RequestPayloadHash：请求内容摘要（冲突检测）

3. 执行原子事务（UsageBillingRepository.Apply）
   (backend/internal/repository/usage_billing_repo.go:22)
   
   BEGIN TRANSACTION
   ├─ claimUsageBillingKey():
   │  ├─ INSERT INTO usage_billing_dedup (request_id, api_key_id, request_fingerprint)
   │  │  ON CONFLICT DO NOTHING
   │  │  → 若已存在（幂等），直接返回 false（不重复扣费）
   │  └─ 检查 archive 表（归档）防止时间跳跃重复
   │
   ├─ applyUsageBillingEffects():
   │  ├─ 若 SubscriptionCost > 0:
   │  │  UPDATE user_subscriptions SET
   │  │    daily_usage_usd = daily_usage_usd + cost,
   │  │    weekly_usage_usd = weekly_usage_usd + cost,
   │  │    monthly_usage_usd = monthly_usage_usd + cost
   │  │
   │  ├─ 若 BalanceCost > 0:
   │  │  UPDATE users SET balance = balance - cost RETURNING balance
   │  │  → 返回扣费后的新余额
   │  │
   │  ├─ 若 APIKeyQuotaCost > 0:
   │  │  UPDATE api_keys SET quota_used = quota_used + cost
   │  │  → 检测 quota_used >= quota，自动标记为 "quota_exhausted"
   │  │
   │  ├─ 若 APIKeyRateLimitCost > 0:
   │  │  UPDATE api_keys SET usage_5h, usage_1d, usage_7d（按窗口）
   │  │  → 滑动窗口追踪 rate limit 使用
   │  │
   │  └─ 若 AccountQuotaCost > 0（仅 APIKey/Bedrock 类型账户）:
   │     UPDATE accounts SET extra = extra || {quota_used: quota_used + cost}
   │     → 上游账号级 quota 追踪
   │
   COMMIT
```

**来源**: `backend/internal/repository/usage_billing_repo.go:22-146`

#### C. 幂等性保证

关键机制：
- **RequestID** 作为主键（user_id, api_key_id 二元组）
- **RequestFingerprint** 作为冲突检测（若两次请求 fingerprint 不同 → 拒绝重复）
- **usage_billing_dedup** 表持久化所有扣费记录
- **usage_billing_dedup_archive** 表定期移库（防止表过大）

若请求重复到达（如网络超时重试）：
- 第一次：成功扣费，记录 fingerprint
- 第二次：`ON CONFLICT DO NOTHING`，返回 `Applied=false`，跳过所有更新

**来源**: `backend/internal/repository/usage_billing_repo.go:65-105`

### 2.3 费用计算（CalculateCostUnified）

**入口**: `backend/internal/service/billing_service.go:412`

```go
func (s *BillingService) CalculateCostUnified(input CostInput) (*CostBreakdown, error)
```

**支持三种计费模式**:

| 模式 | 说明 | 应用场景 |
|------|------|--------|
| `BillingModeToken` | 按 token 数计费 | Claude / GPT / Gemini API |
| `BillingModePerRequest` | 按请求次数固定计费 | 部分 Vision / 长上下文模型 |
| `BillingModeImage` | 按生成图片计费 | Gemini Image Generation |

**Token 计费流程**:

```
1. 获取模型定价 (GetModelPricing / GetModelPricingWithChannel)
   ├─ 动态价格（PricingService → LiteLLM）
   └─ 硬编码回退价格

2. 应用 Service Tier 定价（若存在）
   ├─ priority: 使用 InputPricePerTokenPriority / OutputPricePerTokenPriority
   └─ flex: 使用基础价格 × 0.5 倍率

3. 计算费用 (computeTokenBreakdown)
   ├─ InputCost   = InputTokens * InputPrice
   ├─ OutputCost  = OutputTokens * OutputPrice
   ├─ CacheCreationCost = CacheCreationTokens * CacheCreationPrice
   ├─ CacheReadCost = CacheReadTokens * CacheReadPrice
   └─ ImageOutputCost = ImageTokens * ImagePrice（若有）

4. 应用长上下文倍率（可选）
   若 InputTokens + CacheReadTokens > LongContextInputThreshold:
   ├─ InputPrice *= LongContextInputMultiplier
   └─ OutputPrice *= LongContextOutputMultiplier

5. 应用速率倍率 (RateMultiplier)
   ActualCost = TotalCost * RateMultiplier
```

**来源**: `backend/internal/service/billing_service.go:410-465`

### 2.4 扣费的对象（多维度）

根据 API Key 的 `group_id` 和用户订阅状态决定：

```go
if p.IsSubscriptionBill && p.Subscription != nil {
    // 订阅模式：扣 subscription 额度
    SubscriptionCost = ActualCost
    cmd.SubscriptionID = &p.Subscription.ID
} else {
    // 余额模式：扣用户余额
    BalanceCost = ActualCost
}

// 同时扣 API Key quota（若 API Key 配置了 quota 限制）
if p.APIKey.Quota > 0 {
    APIKeyQuotaCost = ActualCost
}

// 同时扣 API Key rate limit（若 API Key 配置了速率限制）
if p.APIKey.HasRateLimits() {
    APIKeyRateLimitCost = ActualCost
}

// 同时扣上游账号 quota（仅 APIKey/Bedrock 类型账户）
if p.Account.IsAPIKeyOrBedrock() {
    AccountQuotaCost = TotalCost * p.AccountRateMultiplier
}
```

**来源**: `backend/internal/service/gateway_service.go:8032-8080, 7940-7950`

---

## 三、Token 计数来源

### 3.1 来源层级

**优先级**（高到低）：

1. **上游响应 `usage` 字段** — 来自 Anthropic/OpenAI/Gemini 官方 API
2. **流式事件聚合** — SSE 中的 `message_start` / `message_delta` / `message_stop`
3. **缓存分类补齐** — 若上游未提供 5m/1h 细分，自动推断
4. **缓存计数回填** — 若缺失 `cache_read_tokens`，从历史缓存计算

### 3.2 Claude（Anthropic）Token 计数

#### A. 非流式响应

从响应 JSON 直接提取：

```json
{
  "id": "msg_xxx",
  "usage": {
    "input_tokens": 100,
    "output_tokens": 50,
    "cache_creation_input_tokens": 25,
    "cache_read_input_tokens": 10,
    "cache_creation": {
      "ephemeral_5m_input_tokens": 15,
      "ephemeral_1h_input_tokens": 10
    }
  }
}
```

**提取逻辑** (`parseClaudeUsageFromResponseBody` @ `backend/internal/service/gateway_service.go:5545`):

```go
usage.InputTokens = response.usage.input_tokens
usage.OutputTokens = response.usage.output_tokens
usage.CacheCreationTokens = response.usage.cache_creation_input_tokens
usage.CacheReadTokens = response.usage.cache_read_input_tokens

// 若提供 5m/1h 细分，优先使用
if cache_creation.ephemeral_5m_input_tokens > 0 {
    usage.CacheCreation5mTokens = ...
    usage.CacheCreation1hTokens = ...
}
```

#### B. 流式响应（SSE 事件）

Anthropic 流式 API 通过多个事件递送 usage：

| 事件 | 字段位置 | 含义 |
|------|---------|------|
| `message_start` | `message.usage.*` | 初始 token 计数（input） |
| `message_delta` | `usage.*` | 增量输出 token（仅 output） |
| `message_stop` | （无） | 最终停止信号 |

**聚合逻辑** (`parseClaudeStreamUsageFromSSEEvent` @ line:5480):

```go
switch event.type {
case "message_start":
    usage.InputTokens = message.usage.input_tokens
    usage.CacheCreationTokens = message.usage.cache_creation_input_tokens
    usage.CacheReadTokens = message.usage.cache_read_input_tokens

case "message_delta":
    // 增量更新（仅非零值覆盖）
    if delta.usage.output_tokens > 0 {
        usage.OutputTokens += delta.usage.output_tokens
    }
    if delta.usage.cache_read_input_tokens > 0 {
        usage.CacheReadTokens = delta.usage.cache_read_input_tokens
    }
}
```

**来源**: `backend/internal/service/gateway_service.go:5480-5542`

### 3.3 缓存分类补齐（5m vs 1h）

若上游响应未明确提供 `cache_creation.ephemeral_5m_input_tokens` 和 `cache_creation.ephemeral_1h_input_tokens`，系统：

1. 根据 `cache_creation_input_tokens` 总和推断
2. 优先分配到 5m 桶（保守估计）
3. 若有 1h 定价信息，按比例分配

**代码** (`backend/internal/service/gateway_service.go:5531-5542`):

```go
if usage.CacheCreationInputTokens == 0 {
    cc5m := parsed.Get("cache_creation.ephemeral_5m_input_tokens").Int()
    cc1h := parsed.Get("cache_creation.ephemeral_1h_input_tokens").Int()
    total := cc5m + cc1h
    if total > 0 {
        usage.CacheCreationInputTokens = int(total)
    }
}
```

---

## 四、数据结构与表设计

### 4.1 核心表

#### A. `users` 表（用户余额）

```sql
CREATE TABLE users (
  id BIGINT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  balance DECIMAL(20,8) DEFAULT 0,           -- 用户账户余额（USD）
  total_recharged DECIMAL(20,8) DEFAULT 0,   -- 累计充值金额
  balance_notify_enabled BOOL DEFAULT true,  -- 余额不足通知开关
  balance_notify_threshold DECIMAL(20,8),    -- 通知阈值
  ...
);
```

**关键字段**:
- `balance`: 当前可用余额（USD）
- `total_recharged`: 累计充值额（用于 rebate 计算）

**来源**: `backend/ent/schema/user.go:49-51, 96-107`

#### B. `api_keys` 表（API Key 配额）

```sql
CREATE TABLE api_keys (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  key VARCHAR(128) NOT NULL UNIQUE,
  group_id BIGINT,                           -- 分组（用于订阅制）
  quota DECIMAL(20,8) DEFAULT 0,             -- 配额限制（USD，0=无限）
  quota_used DECIMAL(20,8) DEFAULT 0,        -- 已用配额（USD）
  
  -- Rate limit 三个时间窗口
  rate_limit_5h DECIMAL(20,8) DEFAULT 0,     -- 5小时限制（USD）
  rate_limit_1d DECIMAL(20,8) DEFAULT 0,     -- 1天限制（USD）
  rate_limit_7d DECIMAL(20,8) DEFAULT 0,     -- 7天限制（USD）
  
  usage_5h DECIMAL(20,8) DEFAULT 0,          -- 5小时用量
  usage_1d DECIMAL(20,8) DEFAULT 0,          -- 1天用量
  usage_7d DECIMAL(20,8) DEFAULT 0,          -- 7天用量
  
  window_5h_start TIMESTAMPTZ,               -- 5h 窗口起点
  window_1d_start TIMESTAMPTZ,               -- 1d 窗口起点
  window_7d_start TIMESTAMPTZ,               -- 7d 窗口起点
  
  expires_at TIMESTAMPTZ,                    -- API Key 过期时间
  status VARCHAR(20) DEFAULT 'active',       -- 状态（active/exhausted）
  ...
);
```

**关键特性**:
- `quota` > 0 时启用配额限制；`quota_used >= quota` 时自动转为 `status='quota_exhausted'`
- Rate limit 采用**滑动窗口**，自动重置过期窗口
- `status` 字段自动管理（扣费时判断是否达到 quota）

**来源**: `backend/ent/schema/api_key.go:61-117`

#### C. `usage_logs` 表（使用记录，只追加）

```sql
CREATE TABLE usage_logs (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  api_key_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  request_id VARCHAR(64) NOT NULL,
  model VARCHAR(100),
  requested_model VARCHAR(100),              -- 客户端请求的模型
  upstream_model VARCHAR(100),               -- 实际使用的模型
  
  -- Token 计数
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cache_creation_tokens INT DEFAULT 0,
  cache_read_tokens INT DEFAULT 0,
  cache_creation_5m_tokens INT DEFAULT 0,    -- 5分钟缓存 token
  cache_creation_1h_tokens INT DEFAULT 0,    -- 1小时缓存 token
  
  -- 成本明细
  input_cost DECIMAL(20,10) DEFAULT 0,
  output_cost DECIMAL(20,10) DEFAULT 0,
  cache_creation_cost DECIMAL(20,10) DEFAULT 0,
  cache_read_cost DECIMAL(20,10) DEFAULT 0,
  total_cost DECIMAL(20,10) DEFAULT 0,       -- 原始费用（无倍率）
  actual_cost DECIMAL(20,10) DEFAULT 0,      -- 应用倍率后的费用
  
  rate_multiplier DECIMAL(10,4) DEFAULT 1.0, -- 分组倍率
  account_rate_multiplier DECIMAL(10,4),     -- 账号倍率
  
  billing_type INT8 DEFAULT 0,
  billing_mode VARCHAR(20),                  -- "token"/"per_request"/"image"
  
  created_at TIMESTAMPTZ NOT NULL,
  
  FOREIGN KEY (user_id, api_key_id, account_id),
  INDEX(user_id, created_at),
  INDEX(api_key_id, created_at)
);
```

**关键特性**:
- 只追加表（不支持更新/删除）
- 记录每次请求的完整计费数据
- `actual_cost = total_cost * rate_multiplier` 最终扣费金额

**来源**: `backend/ent/schema/usage_log.go:32-196`

#### D. `user_subscriptions` 表（订阅）

```sql
CREATE TABLE user_subscriptions (
  id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  group_id BIGINT NOT NULL,
  status VARCHAR(20) DEFAULT 'active',       -- active/expired/suspended
  
  starts_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  
  daily_window_start TIMESTAMPTZ,            -- 日窗口起点
  weekly_window_start TIMESTAMPTZ,           -- 周窗口起点
  monthly_window_start TIMESTAMPTZ,          -- 月窗口起点
  
  daily_usage_usd DECIMAL(20,10) DEFAULT 0,  -- 当日用量（USD）
  weekly_usage_usd DECIMAL(20,10) DEFAULT 0, -- 当周用量（USD）
  monthly_usage_usd DECIMAL(20,10) DEFAULT 0,-- 当月用量（USD）
  
  assigned_by BIGINT,                        -- 分配者 user_id
  assigned_at TIMESTAMPTZ,
  ...
);
```

**关键特性**:
- 订阅级别的周期用量追踪（无显式限额，仅记录用量）
- 与 `groups` 关联（一个分组可有多个订阅套餐）

**来源**: `backend/ent/schema/user_subscription.go:36-82`

#### E. `accounts` 表（上游账户配额，JSONb 存储）

```sql
CREATE TABLE accounts (
  id BIGINT PRIMARY KEY,
  platform VARCHAR(50),                      -- "anthropic"/"openai"/"gemini"
  type VARCHAR(20),                          -- "oauth"/"apikey"/"setup-token"
  rate_multiplier DECIMAL(10,4) DEFAULT 1.0, -- 账号级费率倍率
  
  extra JSONB DEFAULT '{}',
  -- extra.quota_used: 该账号的累计用量（USD）
  -- extra.quota_daily_limit: 日限额
  -- extra.quota_daily_reset: 日重置时间
  -- extra.quota_weekly_limit: 周限额
  -- extra.quota_total_limit: 总限额
  ...
);
```

**来源**: `backend/ent/schema/account.go:51-196`

#### F. `usage_billing_dedup` 表（扣费去重）

```sql
CREATE TABLE usage_billing_dedup (
  id BIGINT PRIMARY KEY,
  request_id VARCHAR(255) NOT NULL,          -- 客户端/本地/上游 request ID
  api_key_id BIGINT NOT NULL,
  request_fingerprint VARCHAR(128),          -- 请求指纹（冲突检测）
  
  PRIMARY KEY (request_id, api_key_id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 定期归档到
CREATE TABLE usage_billing_dedup_archive LIKE usage_billing_dedup;
```

**关键特性**:
- 保证幂等性（同一请求不重复扣费）
- 定期归档旧记录（防止表过大）

**来源**: `backend/internal/repository/usage_billing_repo.go:65-105`

### 4.2 表间关系

```
users (1) ─────── (n) api_keys
  │
  ├─ (1) ─────── (n) user_subscriptions
  │                   ├─ (n) ──→ groups
  │                   └─ (n) ──→ usage_logs
  │
  └─ (n) ─────── usage_logs

api_keys (1) ─────── (n) usage_logs

accounts (1) ─────── (n) usage_logs
```

---

## 五、费用流向与多渠道支持

### 5.1 订阅制 vs 余额制

一个 API Key 的扣费方式由其 `group_id` 决定：

| 条件 | 扣费方式 | 扣费对象 | 用量追踪 |
|------|---------|--------|--------|
| `group_id` 有关联订阅 | 订阅制 | `user_subscriptions.daily/weekly/monthly_usage_usd` | 周期计数 |
| `group_id` 无订阅 | 余额制 | `users.balance` | 总余额 |

**决定逻辑** (`backend/internal/service/gateway_service.go:8442`):

```go
// 判断计费方式：订阅模式 vs 余额模式
isSubscriptionBill := apiKey.GroupID != nil && subscription != nil && subscription.IsActive()
```

**来源**: `backend/internal/service/gateway_service.go:8440-8450`

### 5.2 多渠道定价覆盖（ChannelModelPricing）

`groups` 表支持为特定分组/渠道覆盖模型定价：

```go
type ChannelModelPricing struct {
    InputPrice    *float64      // 覆盖输入价
    OutputPrice   *float64      // 覆盖输出价
    CacheWritePrice *float64    // 覆盖缓存写价
    CacheReadPrice *float64     // 覆盖缓存读价
    ImageOutputPrice *float64   // 覆盖图片价
}
```

**应用** (`GetModelPricingWithChannel` @ `backend/internal/service/billing_service.go:361`):

```go
basePricing, _ := s.GetModelPricing(model)
if channelPricing != nil {
    if channelPricing.InputPrice != nil {
        basePricing.InputPricePerToken = *channelPricing.InputPrice
    }
    // ... 其他字段
}
```

---

## 六、边界情况处理

### 6.1 余额不足 / 配额耗尽

**不拦截请求** — Sub2API 宽松策略：

```
请求判断：
├─ 配额检查：若 quota_used >= quota → 记录警告，继续
├─ 余额检查：若 balance < estimated_cost → 记录警告，继续
└─ 扣费时：
   ├─ 若扣费成功 → 返回新余额
   └─ 若余额变为负数 → 允许（超透支），触发"余额不足通知"
```

**结果**：
- API Key quota 耗尽时自动转为 `status='quota_exhausted'`
- 余额不足时发送邮件提醒（异步）
- 请求仍被处理，费用照扣（可配置通知策略）

**来源**: `backend/internal/repository/usage_billing_repo.go:194-217`

### 6.2 请求失败 / 上游报错

**扣费逻辑**：

| 场景 | 扣费 | 说明 |
|------|------|------|
| 上游 2xx | ✅ | 成功，按照 usage 扣费 |
| 上游 4xx（参数错误） | ✅ | 已消耗 token，扣费 |
| 上游 401/403（认证失败） | ❌ | 无 token 消耗，不扣费 |
| 上游 429（速率限制） | ❌ | Anthropic 未计费，不扣费 |
| 上游 5xx（服务错误） | ❌ | 无 token 返回，不扣费 |
| 客户端断线中途 | ✅ | 继续消耗上游 token，按实际扣费 |

**扣费时机判断** (`backend/internal/service/gateway_service.go:7670`):

```go
// 仅在成功或部分成功的场景扣费
if resp.StatusCode >= 200 && resp.StatusCode < 300 {
    // 非流式：直接扣费
    cost = s.billingService.CalculateCostUnified(...)
} else if resp.StatusCode >= 400 && resp.StatusCode < 500 {
    // 4xx：检查是否有部分输出
    if hasOutputTokens(usage) {
        cost = s.billingService.CalculateCostUnified(...)
    }
} else {
    // 5xx 或其他：不扣费
    return
}
```

### 6.3 流式响应中途断开

**处理策略**：

```go
if clientDisconnected {
    logger.Log("Client disconnected, continuing to drain upstream for billing")
    
    // 继续消耗上游 stream 直至完成（获取完整 usage）
    drainStreamToCompletion()
    
    // 按实际 usage 扣费
    applyUsageBilling(actualUsage)
}
```

**来源**: `backend/internal/service/gateway_service.go:7503-7551`

---

## 七、缓存与性能优化

### 7.1 余额缓存（Redis）

**模式**：懒加载 + 异步更新

```
GET balance:
├─ 尝试从 Redis 读取
├─ 若 miss → 从 DB 读取 + 写入 Redis
└─ TTL: 30 分钟

SET balance:
├─ 立即写 DB（事务）
└─ 异步更新 Redis（queue）
```

**来源**: `backend/internal/service/billing_cache_service.go:87-350`

### 7.2 定价缓存（进程内 + Redis）

**多层缓存**：

1. **PricingService**（动态加载）→ 本地 cache
2. **BillingService.getFallbackPricing**（硬编码）→ map

无明确 TTL，但动态价格通常每小时刷新。

**来源**: `backend/internal/service/pricing_service.go`, `backend/internal/service/billing_service.go:317-359`

---

## 八、关键代码位置速查表

| 功能 | 文件 | 方法 | 行号 |
|------|------|------|------|
| **计费维度定义** | `billing_service.go` | `ModelPricing` struct | 45-60 |
| **硬编码费率** | `billing_service.go` | `initFallbackPricing` | 134-257 |
| **获取模型定价** | `billing_service.go` | `GetModelPricing` | 317-359 |
| **统一计费入口** | `billing_service.go` | `CalculateCostUnified` | 410-447 |
| **Token 计费计算** | `billing_service.go` | `calculateTokenCost` | 449-464 |
| **原子事务扣费** | `usage_billing_repo.go` | `Apply` | 22-63 |
| **扣费去重检查** | `usage_billing_repo.go` | `claimUsageBillingKey` | 65-105 |
| **扣费效果应用** | `usage_billing_repo.go` | `applyUsageBillingEffects` | 108-146 |
| **余额扣减** | `usage_billing_repo.go` | `deductUsageBillingBalance` | 176-192 |
| **API Key 配额扣减** | `usage_billing_repo.go` | `incrementUsageBillingAPIKeyQuota` | 194-218 |
| **速率限制扣减** | `usage_billing_repo.go` | `incrementUsageBillingAPIKeyRateLimit` | 220-243 |
| **forward 主流程** | `gateway_service.go` | `Forward` | 4349-4700 |
| **Claude token 解析（非流式）** | `gateway_service.go` | `parseClaudeUsageFromResponseBody` | 5545-5577 |
| **Claude token 解析（流式）** | `gateway_service.go` | `parseClaudeStreamUsageFromSSEEvent` | 5480-5542 |
| **统一扣费指令构建** | `gateway_service.go` | `buildUsageBillingCommand` | 8032-8080 |
| **扣费执行（原子）** | `gateway_service.go` | `applyUsageBilling` | 8089-8121 |
| **扣费执行（遗留兼容）** | `gateway_service.go` | `postUsageBilling` | 7955-8000 |
| **User 表结构** | `user.go` (schema) | `User.Fields` | 36-115 |
| **APIKey 表结构** | `api_key.go` (schema) | `APIKey.Fields` | 34-118 |
| **UsageLog 表结构** | `usage_log.go` (schema) | `UsageLog.Fields` | 32-146 |
| **UserSubscription 表结构** | `user_subscription.go` (schema) | `UserSubscription.Fields` | 36-82 |

---

## 九、总结

### 核心特性

| 维度 | 说明 |
|------|------|
| **计费单位** | Token（input/output/cache 细分）+ 缓存细分（5m/1h） |
| **费率来源** | 动态 LiteLLM 配置 + 硬编码回退 |
| **扣费方式** | **后扣**（响应后）+ **原子事务** |
| **幂等性** | RequestID + RequestFingerprint 双重去重 |
| **独立额度** | 用户余额 + API Key 配额 + 订阅周期用量 + 账户配额 |
| **多租户** | ✅ 完整支持（group-based 订阅制） |
| **缓存分类** | Claude 缓存按 TTL 分为 5m/1h 两档 |
| **边界保障** | 宽松政策（允许负余额），事后通知 |

### 设计优势

1. **原子性** — PostgreSQL 事务 + 去重机制 → 零重复扣费
2. **灵活性** — 支持订阅/余额/多维配额混搭
3. **精细化** — Token 级计数 + 缓存分类 + Service Tier 倍率
4. **高性能** — Redis 缓存 + 批量窗口更新 + 异步通知

---

## 附录：流程图

### 请求→响应→扣费完整流程

```
         ┌─────────────────────┐
         │   Client Request    │
         │  (with API Key)     │
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────┐
         │  Handler 鉴权检查    │
         │ (API Key 有效性)    │
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────┐
         │ Forward() 方法       │
         │  • 选择上游账户      │
         │  • Mimicry 伪装      │
         │  • 模型映射         │
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────┐
         │ buildUpstreamRequest│
         │  发送到上游 API      │
         └──────────┬──────────┘
                    ▼
         ┌─────────────────────────┐
         │  上游 API 响应          │
         │  (含 usage 字段)        │
         └──────────┬──────────────┘
                    ▼
         ┌──────────────────────────────┐
         │  parseUsageFromResponse()    │
         │  • 非流式: 直接提取 usage     │
         │  • 流式: SSE 事件聚合        │
         │  • 缓存补齐 (5m/1h)         │
         └──────────┬───────────────────┘
                    ▼
         ┌──────────────────────────────┐
         │  CalculateCostUnified()      │
         │  • GetModelPricing()         │
         │  • computeTokenBreakdown()   │
         │  • 应用 rate multiplier      │
         │  → CostBreakdown            │
         └──────────┬───────────────────┘
                    ▼
         ┌──────────────────────────────┐
         │  buildUsageBillingCommand()  │
         │  • RequestID 解析            │
         │  • Cost 多维度分解           │
         │  → UsageBillingCommand      │
         └──────────┬───────────────────┘
                    ▼
    ┌───────────────────────────────────────┐
    │   applyUsageBilling()                 │
    │   [原子事务开始]                       │
    │   repo.Apply(UsageBillingCommand)    │
    │   ├─ claimUsageBillingKey()          │
    │   │  └─ INSERT dedup (幂等检查)      │
    │   ├─ applyUsageBillingEffects()      │
    │   │  ├─ UPDATE users balance (余额)  │
    │   │  ├─ UPDATE user_subscriptions (订阅) │
    │   │  ├─ UPDATE api_keys quota_used (配额) │
    │   │  ├─ UPDATE api_keys usage_* (限速)   │
    │   │  └─ UPDATE accounts extra (账户)     │
    │   └─ COMMIT                          │
    │   [原子事务结束]                       │
    │   → UsageBillingApplyResult         │
    └───────────────────────────────────────┘
                    ▼
         ┌──────────────────────────────┐
         │  finalizePostUsageBilling()  │
         │  • 队列缓存更新              │
         │  • 触发余额不足通知          │
         │  • 触发账户配额通知          │
         └──────────┬───────────────────┘
                    ▼
         ┌──────────────────────────────┐
         │  writeUsageLogBestEffort()   │
         │  INSERT usage_logs           │
         │  (只追加，最终记录)           │
         └──────────┬───────────────────┘
                    ▼
         ┌──────────────────────────────┐
         │  返回响应给客户端            │
         │  (扣费已完成)                │
         └──────────────────────────────┘
```

---

