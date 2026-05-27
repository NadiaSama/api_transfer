# overview
大模型 API 中转站相关研究

## goals
* 对 sub2api 进行修改：针对 Anthropic 这个platform，增加新的 Account Type. Account Type 的实现方式，是基于 third-party 目录下的一些开源项目进行改进的。


## directory

```bash
.
├── AGENTS.md
├── CLAUDE.md
├── README.md
├── docs
│   ├── AGENTS.md
│   ├── claude-oauth-analysis.md
│   └── sub2api-architecture.md
├── prompts
│   ├── 001-research-sub2api.md
│   ├── 002-claude-oauth.md
│   └── 003.md
├── tests
│   ├── AGENTS.md
│   └── billing-proxy-comparison
├── third_party
│   ├── CLIProxyAPI
│   ├── OmniRoute
│   ├── openclaw-billing-proxy
│   └── sub2api
├── tmp
│   ├── claude-related-open-issues.md
│   ├── install-postgres.sh
│   ├── review
│   └── test_pull.sh
└── worktrees
    └── sub2api


```


* third_party 一些代码仓库用于研究
* docs 整理的文档采用按需加载的机制， 可以读取 docs 目录下的 AGENTS.md 获取每个文档的作用，实现按需加载。
* prompts 我提出了一些工作任务，除非明确说明，不需要主动加载
* tests 集成测试，进入 tests 下工作时需要先读取 tests/AGENTS.md；billing-proxy-comparison 对比 proxy.js 与 Sub2API 的端到端变换一致性
* tmp 临时目录存放一些临时文件
* worktrees/sub2api 从个人仓库clone的sub2api代码用于开发

### worktrees/v2
针对 Anthropic platform 类型增加了新的 Account Type、cliproxy

### wortkrees/sub2api
针对 Anthropic platform 类型增加了新的 Account Type、Billing Proxy

1. 原生模拟 openclaw-billing-proxy 逻辑实现加密
2. 采用代理模式，将请求转发到 openclaw-billing-proxy 服务
