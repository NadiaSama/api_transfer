# overview

./docs/ 目录文档文件索引文件, 每次在当前目录及其子目录下增加文件的时候，都需要更新一下Index，记录下新增文件的作用，方便后续热加载。

## Index

- `sub2api-architecture.md` — Sub2API 后端架构分析，包含多提供商对接机制、Claude/Anthropic 官方 API 集成详解、关键代码位置索引
- `claude-oauth-analysis.md` — 三个仓库 (OmniRoute、openclaw-billing-proxy、sub2api) 的 Claude OAuth 认证实现对比分析，包含 OAuth 流程、Headers、Endpoints、Git 更新信息
- `cliproxyapi-claude-analysis.md` — CLIProxyAPI 的 Claude Code → Anthropic API 转换实现，包含 OAuth 完整流程、请求头伪装、Tool 重映射、响应处理及多 API Key 支持情况分析
- `sub2api-billing.md` — Sub2API 计费 / 额度模块详细分析，包含计费维度、扣费流程、Token 计数来源、数据表设计、边界情况处理、关键代码位置索引
- `cliproxyapi-integration-plan.md` — 在 Sub2API 中以新增 AccountType 的方式集成 CLIProxyAPI 的方案说明，含组件关系 ASCII 图、时序图、可行性评估和落地前 3 个确认点；含 §验证记录 V1（2026-05-27，cliproxy 实例 172.22.239.9:8317 SSE usage 透传字段对账完整，结论计费可正常工作）及 §V1.1（2026-05-27 模型可用性矩阵：Claude Code 别名 `claude-haiku-4-5` / `claude-sonnet-4-5` 全部 502 → 必须配 sub2api model_mapping；`claude-opus-4-7` 单独异常需暂避开；附测试脚本 `tmp/test_cliproxy.sh` 及 overload 连锁锁号说明）
- `error-handling-sub2api-vs-cliproxyapi.md` — Sub2API 与 CLIProxyAPI 各自对 401/403/404/408/429/5xx/529 的处理对比；包含三层处理分支、双层 failover 的语义错配分析，以及 cliproxy AccountType 是否应继续参与 Sub2API failover 的三种策略对比与决策建议
- `cliproxyapi_research.md` — 回答 prompts/004.md 三问：CLIProxyAPI 是否能限制 Claude 订阅 5h/7d 用量、`claude login` 的伪装层次（OAuth 用官方 client_id vs /v1/messages 全方位伪装）、`/v1/models` 列表来源与对 Claude Code 客户端的实际作用；附 §4 部署 Checklist（默认配置文件 / 端口 / 必改项 / Claude 专项 / 最小化起步 patch / §4.5 session-affinity 工作原理与多终端行为）
