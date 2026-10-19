# Token Vault MCP

让 Agent 使用你保存的 Token 执行真正的 `gh` 等 CLI。Agent 通过 MCP 申请 **60 秒有效、只能领取一次** 的链接，再由终端脚本把 Token 放进命令进程的环境变量。长期 Token 不经过 MCP 参数或响应。

每次操作都先在终端生成随机 secret，MCP 只收到它的 S256 哈希。领取时必须同时持有一次性链接和终端 secret，单独拿到对话历史中的链接无法领取。

## 能力与依赖

| 项目 | 当前能力 |
| --- | --- |
| 凭据 | 按名称保存、覆盖、列出元数据、删除；支持 GitHub、OpenAI 等分类和 `other` |
| CLI | 用一次性链接注入 `GH_TOKEN`、`OPENAI_API_KEY` 等环境变量，再执行指定命令 |
| 上传 | 从终端已有的环境变量直接上传；新建与覆盖均需要 MCP 签发链接 |
| 记录 | 手动查看最近 40 条活动元数据，无自动提醒 |
| Cloudflare | 一个 Worker + 一个 D1 数据库 |
| 自有服务器 | 一个 Docker 容器 + SQLite 持久卷，外部提供 HTTPS |
| Agent 环境 | POSIX `sh`、curl 7.55+、openssl、常见 Unix 工具、出站 HTTPS、目标 CLI |
| 构建与打包 | Node.js 24+、npm；打包另需 `tar`。Docker 运行时的 Node 已在镜像内 |

这是**单所有者金库**：持有 MCP 连接密钥的客户端共享整个金库。没有网页管理后台；MCP 不提供终端、不安装 CLI、不授予服务商权限、不代理服务商 API。ChatGPT 网页、Dot、Codex 是否能执行命令，取决于对应会话实际提供的终端与网络能力。

## 部署

先取得源码并安装构建依赖：

```sh
git clone https://github.com/Hanssen0-Alter-Ego/token-vault-mcp.git
cd token-vault-mcp
npm ci
```

### Cloudflare

```sh
npx wrangler login
npx wrangler d1 create token-vault
```

把返回的数据库 ID 填入 `wrangler.jsonc` 的 `database_id`，然后：

```sh
npx wrangler d1 migrations apply DB --remote
npm run cf:deploy
```

用部署返回的实际 HTTPS 域名生成配置并上传 secrets：

```sh
npm run init -- https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev
npm run cf:secrets
```

首次部署到 secrets 配置完成前，金库不可用；完成后 `/health` 应返回 `{"ok":true}`。D1 保存加密凭据与链接消费状态，不能用 Worker 内存替代。费用和免费额度见 [Workers 定价](https://developers.cloudflare.com/workers/platform/pricing/)与 [D1 定价](https://developers.cloudflare.com/d1/platform/pricing/)。

### Docker

```sh
npm run init -- https://YOUR_VAULT_HOST
docker compose up -d --build
```

用你的 HTTPS 反向代理转发到 `127.0.0.1:8787`。SQLite 保存在 `vault-data` 卷中，容器以非 root 用户运行并自动应用迁移，无需独立数据库容器。

### 配置与备份

`npm run init` 新建权限为 `0600` 的 `.env`，拒绝覆盖已有文件，不打印密钥：

| 配置 | 用途 |
| --- | --- |
| `PUBLIC_ORIGIN` | 对外 HTTPS 域名，不带路径或末尾斜杠 |
| `MCP_ACCESS_KEY` | 连接 MCP 的管理密钥 |
| `VAULT_ENCRYPTION_KEY` | AES-256-GCM 存储加密密钥 |

备份数据库和加密密钥；不要提交 `.env`。已有部署保留原密钥。`cf:secrets` 从本地 `.env` 通过标准输入上传配置，不将密钥放进命令参数。

## 安装到 ChatGPT / Codex

服务支持两种连接：

| 认证方式 | MCP 地址 | 宿主设置 |
| --- | --- | --- |
| Bearer | `https://YOUR_VAULT_HOST/mcp` | 在受保护的认证设置中填 `MCP_ACCESS_KEY` |
| 路径密钥 | `https://YOUR_VAULT_HOST/mcp/<MCP_ACCESS_KEY>` | None；整个 URL 都是管理密钥 |

ChatGPT 网页安装时，本项目验证过的是路径密钥方式，不依赖插件设置页提供 Token 输入框。`#fragment` 不会发送给服务端，不能用于 MCP 连接认证。

### 默认：生成自己的私密插件包

在部署目录保留原 `.env`，运行：

```sh
npm run plugin:build
```

输出 `artifacts/token-vault-private.tar.gz`，包含 SKILL、一个 `sh` helper、一个 SHA-256 校验文件、固定 MCP 连接和 Codex 兼容配置。**包内含 MCP 管理密钥，请勿公开或转发。** 不包含 `.env`、加密密钥、数据库或业务 Token。每位使用者用自己的部署和 `.env` 生成自己的包。

1. 在私有对话中选择 Plugin Creator，上传压缩包，要求创建或更新私有插件，且不显示连接 URL 或配置内容。
2. 安装或启用返回的插件，实际调用 `list_tokens`。看到 SKILL、保存成功或 `/health` 正常都不代表连接已可用。
3. 若包内 MCP 未激活：用 **Add custom MCP server** 手动输入包内 `mcp.json` 的 URL，认证选 None；确认工具可调用后，让 Plugin Creator 将包内 SKILL 和配套文件合入这个新插件，保留现有 App 连接、身份和认证。

更新已有插件时，要求同步删除旧的 Node helper 和多余校验文件；仅上传新文件的覆盖更新可能保留旧文件。不要把私密配置粘贴到聊天。上传私密包意味着将连接密钥交给平台保存。

其他打包选项：

```sh
# 指定本地配置或输出目录
npm run plugin:build -- --env-file /PRIVATE_DIR/vault.env --output-dir artifacts

# 不包含任何密钥，适合支持单独配置 Bearer 认证的宿主
npm run plugin:build -- https://YOUR_VAULT_HOST --public
```

无密钥包为 `artifacts/token-vault.tar.gz`；不保证 ChatGPT 网页会提供对应认证输入框。公开源码不等于公开自己的金库连接，也不代表插件目录审核通过。

## 日常使用

安装后可直接告诉 Agent：“将终端已有的 GitHub Token 保存为 `github/main`”或“用 `github/main` 执行 `gh repo view OWNER/REPO`”。精确工具参数和可复制脚本见 [SKILL](plugin/token-vault/skills/token-vault/SKILL.md)，不要让 Agent 重新实现协议。

| MCP 工具 | 作用 |
| --- | --- |
| `list_tokens` | 列出元数据及 `helper.url` / `helper.sha256`，不返回 Token |
| `create_token_write_link` | 签发新建或覆盖凭据的上传链接 |
| `create_token_read_link` | 签发已允许 Agent 使用的凭据领取链接 |
| `delete_token` | 删除金库记录并作废待领取链接 |
| `recent_activity` | 查看最近活动，不含 Token、secret 或领取链接 |

一次操作分三步，同一个终端文件系统中完成：

1. 运行 `sh vault-cli.sh prepare`，生成私有 state 文件，只输出公开的 `claimChallenge`。
2. MCP 用该哈希签发读或写链接，60 秒计时从此刻开始。
3. 把链接通过标准输入交给同一脚本：`run -- command args` 领取并执行 CLI，或 `store` 上传环境变量中的凭据。

脚本路径按实际安装位置填写；仓库中的入口为 `cli/vault-cli.sh`。若终端不能访问插件文件，从 `list_tokens` 的 `helper.url` 下载，先与 SKILL 的 `references/helper-integrity.json` 核对 SHA-256，再执行。只使用 `sh`，不要 source 脚本或 state 文件。

首次上传需要 Token 已在执行 `store` 的进程环境中；没有时由用户在自己的终端隐藏输入，不发到聊天。同名覆盖需用户授权和 `overwrite:true`；可同时更新 `allowAgentUse`。成功领取后，Token 仅注入指定命令及其子进程；不修改父 Shell、不执行持久登录。

## 安全与错误处理

- **403：** secret 缺失或错误，有效链接不消费；**410：** 链接失效、过期或已用。每次失败后重新 prepare 并申请链接，禁止回退到无 secret 领取。
- helper 使用私有临时文件向 curl 传递认证头和上传体，不把凭据写入命令参数；启动目标 CLI 前清理 state。预检失败或进程中断可能留文件，在本地删除，不回显内容。
- 覆盖或删除会作废旧链接；删除记录不会撤销服务商 Token，链接过期不会终止已经取得 Token 的进程。
- secret 绑定防止仅凭对话链接抢领，不能防御被控制的终端、泄露的 MCP 管理密钥或恶意托管方。金库与 HTTPS 终止方仍可见明文 Token。
- 数据库以 AES-256-GCM 保存 Token、仅保存领取码哈希。不要随意更换加密密钥；不要启用 shell tracing 或记录私密 MCP 路径、认证头、请求/响应体。

## 更新已有部署

保留 `.env`、Worker 名称、D1 ID 和 secrets：

```sh
git pull --ff-only
npm ci
npm run cf:deploy
npm run plugin:build
```

Docker 部署用 `docker compose up -d --build` 替代 `cf:deploy`。更新插件中的 SKILL 和配套文件；已有可用的 App 连接无需重建。

**0.4.0 只保留 sh helper：** 删除 Node 下载入口；MCP 的 `helper` 统一指向 `/vault-cli.sh`，不再返回 `shellHelper`。0.3.0 的 sh 脚本及其哈希不变，无需数据库迁移或重置密钥；旧 Node state 不再使用，每次操作重新 prepare。服务端和插件一起更新。

## 开发检查

```sh
npm test
npm run typecheck
npm run build
npx wrangler deploy --dry-run
```

测试使用随机/合成凭据，覆盖 MCP SDK、认证、脚本真实 HTTPS 上传和领取、环境注入、临时文件清理、错误 secret、单次消费、过期/重放、覆盖/删除和打包。包含无 Node/Python/jq/Bash 的 helper 运行测试；不会验证真实服务商 Token 或各产品的终端能力。
