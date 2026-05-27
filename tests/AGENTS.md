# tests 目录说明

本目录存放集成测试和对比验证工具，主要用于验证 `worktrees/sub2api`
中的开发结果是否符合预期。

## billing-proxy-comparison

`billing-proxy-comparison` 是一个基于 Docker Compose 的端到端对比测试工具。

目标：

- 同时启动 `proxy.js`、`sub2api`、PostgreSQL、Redis 和 Mock Anthropic Server。
- 由测试客户端发送相同 payload 到 `proxy.js` 与 `sub2api`。
- 在 Mock Anthropic Server 侧捕获两条链路实际发往上游的 HTTP 请求。
- 对比请求 header、body，以及必要时对比客户端收到的响应，验证 Sub2API 的
  native billing proxy 行为是否与 `openclaw-billing-proxy/proxy.js` 一致。

维护原则：

- 优先验证真实链路行为，而不是只比较单个函数输出。
- 对动态字段做显式归一化或跳过，例如 session id、device id、content-length、
  authorization、随机 request id 等。
- 区分 native 模式与 open/external proxy 模式；不要把两种模式混在同一断言里。
- 若 Go 实现有意偏离 `proxy.js`，必须在测试或文档中说明差异原因。
- 测试失败时应保留足够的 capture 信息，便于定位是请求变换、header 注入、
  响应逆映射还是测试夹具本身的问题。

