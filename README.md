# Token Vault MCP

一个私有 Token 金库：Agent 通过 MCP 申请 **60 秒、只能领取一次** 的链接，在命令进程中直接取得 Token 并执行真正的 `gh` 等 CLI。长期 Token 不进入 MCP 参数或响应。每个链接还绑定终端随机 secret，MCP 只收到 secret 的 S256 哈希；链接和对话历史本身不足以领取 Token。Agent 也可以通过一次性上传链接直接保存进程中已有的凭据。

只有一个服务，包含 MCP、加密存储和领取接口；没有网页后台、API 代理或本地 MCP 依赖。

- **Cloudflare：** 一个 Worker + 一个 D1 数据库。
- **Docker：** 一个容器 + 内置 SQLite 挂载卷，不需要独立数据库容器。
- **插件：** `plugin/` 内含 SKILL、连接模板和打包脚本。

这是单所有者金库。所有持有 MCP 连接密钥的客户端共享该金库的读写权限。

## 生成配置

打包和部署需要 Node.js 24；执行领取/上传脚本不需要 Node，推荐使用 sh + curl + openssl。`npm run init` 生成随机的 MCP 连接密钥和 AES 加密密钥，写入权限为 `0600` 的 `.env`；已有文件时拒绝覆盖，不在终端打印密钥。

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

**网页端限制：** API-key 声明不会自动产生 Token 输入框，官方提交门户也不支持这种连接表单。本项目的网页安装经验是使用固定路径认证，不依赖可变 URL 模板。是否自动建立连接仍由账号和宿主决定。[官方认证配置说明](https://developers.openai.com/plugins/build/plugins#fixed-bearer-tokens-and-api-keys)

### 一条命令生成含密钥的私密插件包

在已部署的项目目录中，保留原有 `.env`，执行：

```sh
npm ci
npm run plugin:build
```

输出到**可见目录** `artifacts/token-vault-private.tar.gz`，终端也会打印完整文件路径。之前的输出在隐藏的 `.package/` 目录；新版不再把成品放在那里。需要 Node.js 24+ 和 `tar`，不会重新生成或修改密钥，也不会部署 Worker。

脚本从本地 `.env` 读取 `PUBLIC_ORIGIN` 和 `MCP_ACCESS_KEY`，把完整的 `https://主机/mcp/密钥` 固定写进 MCP 配置，宿主认证声明为 None；SKILL、经过哈希校验的命令行助手和 Codex 兼容配置一起打包。**不会包含 `.env`、`VAULT_ENCRYPTION_KEY`、数据库或业务 Token。** Linux/macOS 下临时目录为私有目录，文件与压缩包权限为 `0600`；中间文件在打包后清理。终端不打印密钥或私密连接 URL。

密钥文件在其他位置时：

```sh
npm run plugin:build -- --env-file /PRIVATE_DIR/vault.env
```

可使用 `--output-dir` 指定输出目录。旧的 `--path-auth` 参数现在等同于默认私密模式，不再生成尚未验证的 URL 模板。若额外传入域名，必须与该凭据文件的 `PUBLIC_ORIGIN` 完全一致；不接受在命令参数中传入密钥或完整私密 URL。

**这个压缩包含金库的管理密钥，不是加密压缩包。** 拿到它的人可以读写整个个人金库；上传给 ChatGPT/Plugin Creator 也会把此连接密钥交给该平台处理和保存。只用于自己的私有安装，不要上传到公共仓库、公开发布、转发给无权使用该金库的人。`artifacts/` 已从 Git 和 Docker 构建上下文中排除；自行指定其他输出目录时仍须保护文件。分享项目时，让每个人用自己的 `.env` 生成自己的包。

### 上传到 ChatGPT 并确认工具可调用

1. 在私有 ChatGPT 对话中选择 **Plugin Creator**，附加 `artifacts/token-vault-private.tar.gz`。不是把文件发到任意对话就算安装，也不依赖 Settings 中存在压缩包导入按钮。
2. 请求：“使用附件创建私有 Token Vault 插件，包含 SKILL、脚本和 MCP 连接。若已有同一插件则更新。连接 URL 含密钥，不要在回复中展示它或配置内容。”
3. 打开返回的插件页面，安装或启用。确认发现 `list_tokens`、`create_token_read_link`、`create_token_write_link`、`delete_token`、`recent_activity`，并实际调用一次 `list_tokens`。压缩包已生成、插件已保存、`/health` 正常都不能替代这一步。

**若宿主没有激活包内的远程 MCP：** 在 Plugins → ＋ → Add custom MCP server 中，填写包内 `mcp.json` 的完整 URL（在本机查看，不发到聊天），认证选 None。先确认五个工具出现、设置页可打开、`list_tokens` 可调用，再把新插件的链接/技术 ID 和压缩包交给 Plugin Creator，要求“仅合入 SKILL 与配套脚本，保留现有 App 连接、身份、名称和认证设置”。这就是本次验证可行的回退流程。不要通过给坏连接反复补 SKILL、换聊天或重置加密密钥来排查。

### 不含密钥的包

```sh
npm run plugin:build -- https://YOUR_VAULT_HOST --public
```

输出 `artifacts/token-vault.tar.gz`，使用固定 `/mcp` 地址和 Bearer/API-key 声明；即使本地 `.env` 存在，也不写入任何密钥。适合支持单独配置认证的宿主；不能承诺 ChatGPT 网页会提供对应输入框。它是源码/私有分发包，不代表已通过公开插件目录的审核。

`0.3.0` 包同时包含 sh 和 Node 两个助手。随包提供的 sh 脚本可以与 `0.2.0` 起的 S256 服务端配合；若要通过 Worker 下载 `/vault-cli.sh` 或让 MCP 返回 `shellHelper`，需更新并部署 Worker。每个人的安装、工具调用和 ChatGPT/Dot 终端能力仍需在各自环境验证。

## 使用：直接调用随 SKILL 提供的脚本

MCP 工具：`list_tokens`、`create_token_read_link`、`create_token_write_link`、`delete_token`、`recent_activity`。SKILL 和可运行脚本在 `plugin/token-vault/skills/token-vault/`；默认脚本是 `cli/vault-cli.sh`，仅需 POSIX sh、curl（支持从文件读取请求头，7.55+）、openssl 和常见系统工具；不需要 Node、Python、jq 或 Bash。原有 `cli/vault-cli.mjs` 保留为可选版本。不要让 Agent 重新实现随机数、哈希、校验头或 env 注入逻辑。

**每次领取/上传都先准备新的终端 secret。** 在当前仓库可以直接运行：

```sh
mktemp -d
```

记下返回的私有目录，用它替换下面的 `/PRIVATE_DIR`。然后：

```sh
sh cli/vault-cli.sh prepare --origin https://YOUR_VAULT_HOST --env GH_TOKEN --state /PRIVATE_DIR/read.claim.state
```

脚本生成 32 字节随机 secret，保存在新建的 `0600` 文件；只输出 `{ "claimChallenge": "PUBLIC_S256_HASH", "method": "S256" }`。不要读取、打印或上传 state 文件。secret 由终端程序生成，不由模型编造。MCP 只提交输出中的公开哈希。

读取时，Agent 调用 `create_token_read_link`：

```json
{"name":"github/main","purpose":"读取指定仓库","claimChallenge":"PUBLIC_S256_HASH"}
```

用同一个 state 文件领取并执行命令：

```sh
sh cli/vault-cli.sh run --origin https://YOUR_VAULT_HOST --env GH_TOKEN --state /PRIVATE_DIR/read.claim.state -- gh repo view OWNER/REPO <<'VAULT_LINK'
ONE_TIME_READ_URL
VAULT_LINK
```

脚本内部读取 secret，把它放在 `X-Vault-Verifier` 请求头中；业务 Token 只进入子进程环境。state 文件在启动 CLI 前删除。脚本不打印领取响应，不改变父 Shell，也不执行持久登录。Agent 需要自己的终端、出站 HTTPS、sh、curl、openssl 和目标 CLI；MCP 本身不提供终端。

**上传已有凭据也使用相同流程：** 先用 `prepare` 创建新的 `/PRIVATE_DIR/write.claim.state`，然后调用 `create_token_write_link`：

```json
{"name":"github/main","provider":"github","envVar":"GH_TOKEN","allowAgentUse":true,"overwrite":false,"purpose":"保存 GitHub 凭据","claimChallenge":"PUBLIC_S256_HASH"}
```

终端已有 `GH_TOKEN` 时直接上传：

```sh
sh cli/vault-cli.sh store --origin https://YOUR_VAULT_HOST --env GH_TOKEN --state /PRIVATE_DIR/write.claim.state <<'VAULT_LINK'
ONE_TIME_WRITE_URL
VAULT_LINK
```

两个助手都随插件打包。如果终端无法访问插件文件，新版 `list_tokens` 返回公开的 `shellHelper.url` 和 SHA-256；下载 sh 助手后应与 SKILL 的 `references/shell-helper-integrity.json` 对照验证，再使用。原有 `helper.url` 和 `references/helper-integrity.json` 继续对应 Node 版。服务器与插件版本不一致时先更新，不要执行未核对的脚本。

secret 文件用于衔接终端 → MCP → 终端三个步骤，需要在同一个终端文件系统中完成。准备早于链接签发；链接的 60 秒有效期从签发时开始。每个新链接使用新 secret，失败后重新 prepare 并签发。有效 state 在请求失败后也会清理；预检失败、进程被中断或崩溃时可能遗留文件，需要在本地删除，不要回显内容。

sh 版使用不执行代码的独立 state 格式，Node 版使用 JSON；一次领取从 `prepare` 到 `run/store` 必须使用同一个助手，不要混用 state。两个版本都只输出公开哈希，secret 留在私有文件中。sh 版通过权限为 `0600` 的临时文件向 curl 传递认证头和请求体，不将 secret 或 Token 写入进程命令参数；执行目标命令前清理这些文件。

上传/更新分为两层授权：调用 `create_token_write_link` 需要 MCP 主密钥；实际 POST 上传仅使用已签发的一次性领取码和匹配的终端 secret，不再携带 MCP 主密钥。同名覆盖仍需用户授权并设置 `overwrite:true`。

## 升级到 0.2.0

服务端现在强制校验 `claimChallenge` 和 `X-Vault-Verifier`，不兼容旧版直接领取。同步更新服务端、插件包和命令行助手。已存 Token 和原有加密密钥保持不变，不需要新增数据库迁移；旧的无绑定链接会被拒绝。

## 升级到 0.3.0

新增无需 Node 的 sh 助手，并修复 Node 助手真实 CLI 入口把 `fs/promises.readFile(0)` 当成标准输入读取方式的问题，改为读取 stdin 流。新增测试直接启动两个 CLI，通过标准输入传入链接，在启用证书校验的真实 HTTPS 服务上完成上传和读取；还在 PATH 中没有 Node/Python/jq/Bash 的环境中运行 sh 助手。

保留原来的 `.env`、Worker 名称、D1 ID 和所有 secrets，运行：

```sh
git pull --ff-only
npm ci
npm run cf:deploy
npm run plugin:build
```

无需数据库迁移或重置密钥。同步更新插件中的 SKILL、两个脚本及其哈希文件；若改动只在本地脚本，旧 S256 Worker 也可使用，但线上 `/vault-cli.mjs`、`/vault-cli.sh` 和 `shellHelper` 元数据要等 Worker 部署后才会更新。

## 必要边界

- 缺失/错误 secret 返回 403，不消费有效链接；`recent_activity` 会记录 `read.proof_rejected` / `write.proof_rejected`。该工具用于手动检查，没有自动推送报警。
- 这项绑定防止只拿到链接/对话历史的人抢领，不是针对 Cloudflare 的端到端加密。TLS 终止方、金库运行方仍能看到凭据；MCP 主密钥或终端权限失守也不受该绑定保护。
- 一次性链接仍是敏感的短期授权信息，可能进入工具历史；但缺少终端 secret 时不能领取。60 秒只限制领取，不会使业务 Token 本身过期。
- GET/预览不消费链接；正确 secret 和领取码在同一个数据库原子操作中校验并消费。网络中断或审计失败后也可能已消费，请重新申请。
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

测试使用合成凭据，包含官方 MCP SDK 的初始化/工具调用、认证、S256 标准测试向量、链接/哈希泄漏后的领取拒绝、secret 跨链接不匹配、错误 proof 不消费链接、临时文件权限与清理、并发单次消费、过期/重放、覆盖与撤销、审计失败关闭，以及真实子进程环境注入；不会验证你的真实 GitHub/OpenAI Token 或 Dot 环境。
