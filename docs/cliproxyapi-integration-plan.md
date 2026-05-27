# CLIProxyAPI 集成方案（Sub2API 新增 AccountType）

> 目的：为公司员工提供"Claude 订阅 → API"的转换服务，复用 Sub2API 的鉴权计费能力，把与 Anthropic 的交互细节交给 CLIProxyAPI。

## 方案概述

**核心思路**：把 CLIProxyAPI 当成 Sub2API 的一个新上游端点；在 Sub2API 的 Anthropic Platform 下新增一个 AccountType（类型 = `CLIProxyAPI`），让请求按下面的链路流转。

这不是新发明的模式 —— Sub2API 现有的 "Billing Proxy" AccountType（转发到 `openclaw-billing-proxy`）就是同一种**代理型 AccountType**，本方案只是再加一个具体实现。

## 组件关系图

```
请求方向 ─────────────────────────────────────────────────────────────────────>

┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   员工/客户   │ ─> │   Sub2API    │ ─> │ CLIProxyAPI  │ ─> │ Anthropic API │
│  (API Key)   │    │  鉴权 + 计费  │    │ OAuth + 伪装  │    │   (上游)      │
└─────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                          ▲                                        │
                          └────────── SSE 响应 + usage ────────────┘
                                <────────────────────────

<───────────────────────────────────────────────────────────────── 响应方向
```

## 各组件职责

```
┌────────────────┬──────────────────────────┬─────────────────────────────┐
│     组件        │          职责             │       与上下游的关系          │
├────────────────┼──────────────────────────┼─────────────────────────────┤
│                 │  1. API Key 鉴权          │  入口 ← 员工 (对外 API)       │
│   Sub2API       │  2. 四层配额检查           │  出口 → CLIProxyAPI          │
│                 │  3. Usage 解析 + 扣费      │                              │
│                 │  4. 多租户隔离             │  (新增 CLIProxyAPI 端点类型)  │
├────────────────┼──────────────────────────┼─────────────────────────────┤
│                 │  1. OAuth Token 管理      │  入口 ← Sub2API              │
│  CLIProxyAPI    │  2. Header / Tool 伪装    │  出口 → Anthropic            │
│                 │  3. 多 Claude 订阅 LB      │  (持有真实订阅凭据)           │
├────────────────┼──────────────────────────┼─────────────────────────────┤
│                 │  真正提供 LLM 服务         │  入口 ← CLIProxyAPI          │
│  Anthropic API  │  返回 SSE 流 + usage      │  响应原路透传回去             │
└────────────────┴──────────────────────────┴─────────────────────────────┘
```

**一句话总结**：Sub2API 管"对谁开放、用多少"，CLIProxyAPI 管"怎么伪装成 Claude Code 跟 Anthropic 说话"，两者职责无重叠。

## 时序流程（Mermaid）

```mermaid
sequenceDiagram
    autonumber
    participant U as 公司员工<br/>(Claude Code / API 客户端)
    participant S as Sub2API<br/>权限 & 计费层
    participant C as CLIProxyAPI<br/>Anthropic 适配层
    participant A as Anthropic 官方

    U->>S: 携带个人 API Key 请求
    S->>S: 鉴权 + 配额预检<br/>(用户余额 / Key 限额)
    S->>C: 透传请求<br/>(AccountType=CLIProxyAPI)
    C->>C: 注入 OAuth Token<br/>伪装 Header / 重映射 Tool 名<br/>选择上游订阅 (Round-Robin)
    C->>A: 模拟 Claude Code 客户端请求
    A-->>C: SSE 流式响应 (含 usage)
    C-->>S: 响应直通 (保留 usage)
    S->>S: 解析 usage<br/>事务扣费 + 记录到 dedup 表
    S-->>U: 流式响应
```

## 静态架构图（Mermaid）

```mermaid
flowchart LR
    Emp[公司员工<br/>多个 API Key]

    subgraph Sub2API["Sub2API（已有能力，复用）"]
        Auth[API Key 鉴权]
        Quota[四层配额<br/>用户/Key/订阅/账户]
        Bill[Usage 解析 & 扣费]
        AT[新增 AccountType:<br/>CLIProxyAPI]
        Auth --> Quota --> AT --> Bill
    end

    subgraph CLIProxy["CLIProxyAPI（新增端点，封装上游细节）"]
        OAuth[OAuth Token 管理]
        Mask[Header 伪装<br/>Tool 重映射]
        LB[多 Claude 订阅<br/>负载均衡]
    end

    Anth[(Anthropic API)]

    Emp -->|API Key| Auth
    AT -->|内部转发| OAuth
    OAuth --> Mask --> LB --> Anth
    Anth -.SSE+usage.-> Bill
```

## 可行性评估

### 为什么成

1. **Sub2API 计费层够用** —— 四层额度（用户余额 / API Key 配额 / 分组订阅 / 上游账户）正好对应"给员工每人发个 Key、每 Key 限多少 token / 月"的需求；后扣模式 + `usage_billing_dedup` 幂等机制，多跳也安全。详见 [`sub2api-billing.md`](./sub2api-billing.md)。
2. **CLIProxyAPI 责任清晰** —— OAuth 回调、Token 刷新、Header 伪装、Tool 重映射、多订阅 round-robin 全在它那一层闭环，Sub2API 不用碰这些 Anthropic 细节。详见 [`cliproxyapi-claude-analysis.md`](./cliproxyapi-claude-analysis.md)。
3. **职责零重叠** —— CLIProxyAPI 本来就缺的（per-key 配额、用户隔离）正好是 Sub2API 的强项；反过来 Sub2API 不想自己重写一遍 OAuth 也合理。
4. **现有先例** —— Sub2API 已经有 "Billing Proxy" AccountType（转发到 `openclaw-billing-proxy`），新增一个 CLIProxyAPI AccountType 是同一种代理模式的复用，改造成本可控。

### 落地前要确认的 3 个点

1. **Usage 直通** —— CLIProxyAPI 必须**原样转发** Anthropic SSE 的 `message_start` / `message_delta` 中的 `usage` 字段，否则 Sub2API 无法扣费。需要审一遍它的响应处理代码，确认没有动这些事件。 → **已验证通过**，见下文 §验证记录 V1。
2. **SSE 双跳** —— 两层都要正确处理流式（不能缓冲整段再吐），否则首 token 延迟会很难看。要做端到端压测。
3. **错误码透传** —— 上游 429 / 401 必须原样回来。让 Sub2API 能正确区分"上游账户挂了"还是"用户配额满了"，否则计费/降级会出错。

## 验证记录

### V1（2026-05-27）：Usage 直通 — ✅ 通过

**测试环境**：cliproxy 实例 `http://172.22.239.9:8317`，api-key `bdca301a22032e9cf1f9c010ff857097`

**请求**：
```bash
curl -N http://172.22.239.9:8317/v1/messages \
  -H "x-api-key: bdca301a22032e9cf1f9c010ff857097" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":50,"stream":true,
       "messages":[{"role":"user","content":"hi, reply ok"}]}'
```

**响应关键事件**（cliproxy 未改写）：

`message_start`：
```json
"usage":{
  "input_tokens": 1368,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0},
  "output_tokens": 1,
  "service_tier": "standard",
  "inference_geo": "not_available",
  "speed": "standard"
}
```

`message_delta`：
```json
"usage":{
  "input_tokens": 1368,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0,
  "output_tokens": 4
}
```

**与 sub2api 解析器对账**（`parseClaudeUsageFromResponseBody` @ `backend/internal/service/gateway_service.go:5572`）：

| sub2api 需要字段 | SSE 是否提供 |
|---|---|
| `input_tokens` | ✅ |
| `output_tokens` | ✅（终态 message_delta = 4） |
| `cache_creation_input_tokens` | ✅ |
| `cache_read_input_tokens` | ✅ |
| `cache_creation.ephemeral_5m_input_tokens` | ✅ |
| `cache_creation.ephemeral_1h_input_tokens` | ✅ |
| `service_tier` | ✅（用于 priority / flex 倍率） |

**结论**：cliproxy 没有动 usage 块。sub2api 透传链路（`gateway_service.go:4361` cliproxy → `forwardAnthropicAPIKeyPassthroughWithInput` → `parseClaudeUsageFromResponseBody` → `CalculateCostUnified` → `applyUsageBilling`）能按 Haiku $1/$5/$1.25/$0.10 per MTok 正确扣费。

**额外发现**：
- 模型 ID 必须是 cliproxy `/v1/models` 列表里**注册过**的精确 ID（用别名如 `claude-opus-4-5` 会 502 "unknown provider for model"），需在 sub2api 后台做 model mapping，把客户端简写映射到 cliproxy 接受的全名。
- cliproxy 额外透传了 `inference_geo`、`speed`、`context_management.applied_edits` 等新字段，sub2api `json.Unmarshal` 忽略未知字段，不会因此报错。

**待验证**：V2（SSE 双跳延迟）、V3（错误码透传 429/401/529）尚未做。

---

### V1.1（2026-05-27）：模型可用性矩阵 — ⚠️ 别名 100% 不可用 + opus-4-7 异常

**测试脚本**：[`/tmp/test_cliproxy.sh`](../tmp/test_cliproxy.sh) — 对每个模型同时跑 stream + non-stream，校验 HTTP code 和 usage 字段。

**测试矩阵**（cliproxy `http://172.22.239.9:8317`，2026-05-27 上午）：

| 模型 ID | 非流式 | 流式 | 备注 |
|---|---|---|---|
| `claude-haiku-4-5-20251001` | ✅ 200 | ✅ 200 usage 完整 | 默认推荐主模型 |
| `claude-sonnet-4-5-20250929` | ✅ 200 | ✅ 200 usage 完整 | |
| `claude-opus-4-6` | ✅ 200 | ✅ 200 usage 完整 | |
| `claude-sonnet-4-6` | ✅ 200 | ✅ 200 usage 完整 | |
| **`claude-opus-4-7`** | ❌ **529 Overloaded** | ⚠️ **200 但 usage 缺失** | **见下方专项分析** |
| `claude-haiku-4-5`（别名） | ❌ 502 unknown provider | ❌ 502 | Claude Code 默认副模型 |
| `claude-sonnet-4-5`（别名） | ❌ 502 unknown provider | ❌ 502 | Claude Code 旧版默认主模型 |
| `claude-opus-4-5`（别名） | ❌ 502 unknown provider | ❌ 502 | |

#### 问题 1：模型别名（必修）

**症状**：Claude Code 启动后一直重试，sub2api 日志看不到错误（因为请求根本没到 sub2api 的 forward 阶段，503 直接返回）。

**根因**：Claude Code 默认会**并发**发多种模型请求：
- 主对话用 `--model` 指定的模型
- **副请求**（话题摘要、token 估算、工具决策）固定使用 `claude-haiku-4-5` 别名 → cliproxy `internal/registry/` 只注册完整 ID（带日期后缀），别名一律返回 502。

任意一边失败 → Claude Code 进入指数退避重试 → 表象就是"卡住一直转圈"。

**修复**：在 sub2api 后台 Account → Edit → **Model Mapping** 字段配：

```json
{
  "claude-haiku-4-5":  "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5": "claude-sonnet-4-5-20250929",
  "claude-opus-4-5":   "claude-opus-4-5-20251101"
}
```

sub2api 透传分支（`gateway_service.go:4365`）会在转发前调 `account.GetMappedModel(model)` 重写成 cliproxy 接受的全名，对客户端透明。

**为什么不在 cliproxy 侧做映射**：cliproxy 的 `internal/registry/` 是基于 Anthropic 官方 `/v1/models` 拉取的精确清单，加别名相当于改第三方代码。在 sub2api 侧做转换 = 改一个 JSON 字段，且对其他客户端（非 Claude Code）也兼容。

#### 问题 2：`claude-opus-4-7` 异常（暂避开）

**症状**：
- 非流式：HTTP 529 `{"type":"overloaded_error","message":"Overloaded"}`
- 流式：HTTP 200，但 SSE 流里**缺 `message_start.usage` 字段** → sub2api 解析为零 token → 扣费失败

**奇怪之处**：同时段 `claude-opus-4-6` 完全正常，唯独 4-7 这一个版本有问题。同一个 Claude 订阅账号**直接登录 Claude Code 客户端使用 4-7 完全没问题** → 排除 Anthropic 上游限流根因，怀疑是 cliproxy 对 4-7 的 header 伪装 / tool 重映射有遗漏。

**临时规避**：让用户用 4-6 代替 4-7：
```bash
claude --model 'claude-opus-4-6'
# 或环境变量
export ANTHROPIC_MODEL="claude-opus-4-6"
```

**待跟进**：
1. 升级 cliproxy 看是否修复对 opus-4-7 的支持
2. 翻 cliproxy `internal/translator/anthropic/` 看 opus-4-7 是否有特殊分支
3. 如果长期不修，在 sub2api model_mapping 里把 `claude-opus-4-7` → `claude-opus-4-6` 兜底

#### 连锁影响（曾让定位走偏）

sub2api 检测到 cliproxy 返回 529 后会**给账号打 overload 锁**（`account.go:140-142` 的 `OverloadUntil`）。被锁期间所有请求都得到 503 `no available accounts`，看起来像账号被禁。**解锁方式**：
- 等 `overload_until` 自然过期
- 管理端手动清掉该字段
- 重启 sub2api（缓存清零）

#### 验证脚本可复用

```bash
# 默认参数
/home/eeiwant/work/AI/api_transfer/tmp/test_cliproxy.sh

# 只测一个模型
TEST_MODEL=claude-opus-4-7 /home/eeiwant/work/AI/api_transfer/tmp/test_cliproxy.sh

# 换 host/key
CLIPROXY_HOST=http://x.x.x.x:8317 \
CLIPROXY_KEY=xxxxx \
/home/eeiwant/work/AI/api_transfer/tmp/test_cliproxy.sh
```

脚本输出彩色矩阵，对失败行单独汇总，便于回归。

## 相关文档

- [`sub2api-architecture.md`](./sub2api-architecture.md) — Sub2API 整体架构
- [`sub2api-billing.md`](./sub2api-billing.md) — 计费/配额模块细节
- [`cliproxyapi-claude-analysis.md`](./cliproxyapi-claude-analysis.md) — CLIProxyAPI Claude Code 转换实现
- [`claude-oauth-analysis.md`](./claude-oauth-analysis.md) — Claude OAuth 流程对比
