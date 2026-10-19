# Token Vault MCP

一个私有 Token 金库：Agent 通过 MCP 申请 **60 秒、只能领取一次** 的链接，在命令进程中直接取得 Token 并执行真正的 `gh` 等 CLI。长期 Token 不进入 MCP 参数或响应。Agent 也可以通过一次性上传链接直接保存进程中已有的凭据。

只有一个服务，包含 MCP、加密存储和领取接口；没有网页后台、API 代理或本地 MCP 依赖。

- **Cloudflare：** 一个 Worker + 一个 D1 数据库。
- **Docker：** 一个容器 + 内置 SQLite 挂载卷，不需要独立数据库容器。
- **插件：** `plugin/` 内含 SKILL、连接模板和打包脚本。

这是单所有者金库。所有持有 MCP 连接密钥的客户端共享该金库的读写权限。

## 生成配置

需要 Node.js 24。`npm run init` 生成随机的 MCP 连接密钥和 AES 加密密钥，写入权限为 `0600` 的 `.env`；已有文件时拒绝覆盖，不在终端打印密钥。

```sh
npm ci
npm run init -- https://YOUR_VAULT_HOST
```

把域名换成真实的 HTTPS origin，不带末尾斜杠。`.env` 中只有三个必需配置：`PUBLIC_ORIGIN`、`MCP_ACCESS_KEY`、`VAULT_ENCRYPTION_KEY`。不要上传 `.env`；加密密钥必须安全备份。

## Cloudflare 部署

```sh
npm ci
npx wrangler login
npx wrangler d1 create token-vault
```

将返回的 D1 ID 填到 `wrangler.jsonc` 的 `database_id`，然后：

```sh
npx wrangler d1 migrations apply DB --remote
npm run cf:deploy
```

第一次部署先创建 Worker；配置不完整时，所有金库操作都会返回不可用。复制 Wrangler 返回的实际 HTTPS 域名生成配置，再上传 secrets：

```sh
npm run init -- https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
npm run cf:secrets
```

如果之前已生成 `.env`，只编辑其中的 `PUBLIC_ORIGIN`，不要重新生成或覆盖密钥。`cf:secrets` 通过标准输入将三个值上传到 Worker secrets；不把密钥放进命令行参数。随后访问 `/health` 应返回 `{"ok":true}`。

D1 用来持久保存加密 Token 和链接的消费状态，Worker 内存无法替代。个人使用预计可落在免费额度：Workers 每天 10 万请求；D1 每天 500 万行读取、10 万行写入，5 GB 总存储。免费 D1 超额会暂停查询，而非自动升级收费。详见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)和 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)。

## Docker 部署

配置 `.env` 的域名为你对外提供 HTTPS 的域名，再运行：

```sh
docker compose up -d --build
```

一个容器，SQLite 在 `vault-data` 卷中。只映射宿主 `127.0.0.1:8787`，请通过你已有的 HTTPS 反向代理转发到此端口。容器以非 root 用户运行，自动应用数据库迁移。没有额外的数据库容器或管理后台。

## 连接插件或自定义 MCP

服务端已实现并测试两种认证：

1. **优先：** `https://YOUR_VAULT_HOST/mcp`，认证头为 `Authorization: Bearer <MCP_ACCESS_KEY>`。
2. **兼容方式：** `https://YOUR_VAULT_HOST/mcp/<MCP_ACCESS_KEY>`，宿主选无需额外认证。整个 URL 等价于管理密钥，不能公开。

`#fragment` 不会随 HTTP 请求发送，不能拿来做 MCP 连接认证。业务 Token 不属于 MCP 连接配置，二者是不同的密钥。

**网页端限制：** 插件配置规范支持 API-key 声明；OpenAI 官方同时说明提交门户连接表单不支持该声明。因此不能仅凭 `mcp.json` 就断言网页一定有独立 Token 输入框。包提供 `urlTemplates` 自定义主机模板；认证界面的实际行为仍须在部署和安装后验证。没有宣称当前插件已经完成 ChatGPT/Dot 连接。[官方认证配置说明](https://developers.openai.com/plugins/build/plugins#fixed-bearer-tokens-and-api-keys)

部署后生成含 SKILL 和 MCP 的插件包；命令只接收不含密钥的域名：

```sh
npm run plugin:build -- https://YOUR_VAULT_HOST
# 网页不支持独立 Token 输入时，生成支持 host + token 私密路径模板的版本：
npm run plugin:build -- https://YOUR_VAULT_HOST --path-auth
```

输出 `.package/token-vault.tar.gz`，包不含连接密钥。默认包声明 Bearer/API-key，兼容包声明 `https://{vault_host}/mcp/{vault_token}`；在支持该模板的宿主连接设置中填写自己的主机和密钥。如果宿主不提供模板配置，也可先通过自定义 MCP 配置完整私密 URL，再使用同一个 SKILL。不要把密钥写进公共仓库或分享插件包。

`plugin/` 是插件源码和模板，尚未创建到账号。没有真实部署地址时不创建占位连接。安装、工具发现和 ChatGPT/Dot 终端能力需部署后再验证。

## 使用

MCP 工具：`list_tokens`、`create_token_read_link`、`create_token_write_link`、`delete_token`、`recent_activity`。SKILL 在 `plugin/token-vault/skills/token-vault/SKILL.md`。

先申请上传链接，例如：

```json
{"name":"github/main","provider":"github","envVar":"GH_TOKEN","allowAgentUse":true,"overwrite":false,"purpose":"保存 GitHub 凭据"}
```

终端已有 `GH_TOKEN` 时，直接上传，不把它返回给模型：

```sh
node vault-cli.mjs store --origin https://YOUR_VAULT_HOST --env GH_TOKEN <<'VAULT_LINK'
ONE_TIME_WRITE_URL
VAULT_LINK
```

读取时，Agent 调用 `create_token_read_link`，传 `{name, purpose}`，再执行：

```sh
node vault-cli.mjs run --origin https://YOUR_VAULT_HOST --env GH_TOKEN -- gh repo view OWNER/REPO <<'VAULT_LINK'
ONE_TIME_READ_URL
VAULT_LINK
```

助手随插件打包，也可从签发结果的 `helper.url` 下载。下载后必须核对 `helper.sha256`；准备耗时超过 60 秒就重新申请链接。助手只把 Token 传给子进程环境，不打印领取响应、不改变父 Shell，也不执行持久登录。Agent 必须已经有终端、出站 HTTPS、Node.js 24 和所需 CLI；MCP 本身不提供终端。

## 必要边界

- 一次性链接也是短期凭据，可能进入工具历史。60 秒只限制领取，不会使业务 Token 本身过期。
- GET/预览不消费链接；POST 以数据库原子操作消费。网络中断或审计失败后也可能已消费，请重新申请。
- 覆盖同名凭据须 `overwrite:true`；更新、关闭 Agent 使用或删除时作废旧链接。删除金库记录不会撤销服务商 Token。
- 所有存储 Token 均使用 AES-256-GCM，绑定所有者和记录 ID；数据库只存领取码的哈希。不要随意轮换加密密钥，否则旧记录无法解密。
- 不记录 Token、领取码或请求体。避免额外配置包含私密 MCP 路径、认证头和响应体的代理日志；不要开启 shell tracing 或让 CLI 打印/保存凭据。
- Token 一旦交给进程，金库无法约束它的用途或权限。客户端持有连接密钥即拥有整个个人金库的 MCP 权限。

## 检查

```sh
npm ci
npm test
npm run typecheck
npm run build
npx wrangler deploy --dry-run
```

测试使用合成凭据，包含官方 MCP SDK 的初始化/工具调用、认证、并发单次消费、过期/重放、覆盖与撤销、审计失败关闭，以及真实子进程环境注入；不会验证你的真实 GitHub/OpenAI Token 或 Dot 环境。
