# Token Vault MCP

让 Agent 使用你保存的 Token 执行 `gh` 等 CLI。读取通过本地临时密钥和 MCP 加密信封完成，固定 Node 24 helper 离线解密并只注入目标子进程；明文 Token 和私钥不经过 MCP。上传仍使用绑定终端 secret 的一次性写入链接。

## 能力与依赖

| 项目 | 当前能力 |
| --- | --- |
| 凭据 | 按名称保存、覆盖、列出元数据、删除；所有保存的凭据均可领取，无需开启开关 |
| CLI | 用加密信封注入 `GH_TOKEN`、`OPENAI_API_KEY` 等环境变量，再执行指定命令 |
| 上传 | Agent 用一次性链接上传；用户可用 MCP 管理密钥直接手动上传 |
| 记录 | 手动查看最近 40 条活动元数据，无自动提醒 |
| Cloudflare | 一个 Worker + 一个 D1 数据库 |
| 自有服务器 | 一个 Docker 容器 + SQLite 持久卷，外部提供 HTTPS |
| Agent 环境 | 读取：Node 24+、目标 CLI；上传另需 POSIX `sh`、curl 7.55+、openssl、出站 HTTPS |
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

### Cloudflare 请求诊断日志

`wrangler.jsonc` 启用自定义日志，禁用自动 invocation logs 和 traces。Worker 每次返回响应时写入 `vault_request`，字段仅含固定路由标签、HTTP 状态码和处理耗时（毫秒）。在 Worker 的 Logs 中搜索 `vault_request`，按请求时间排查 `redeem_read` / `redeem_write` 的状态。

不要在 Dashboard 重新打开 invocation logs 或 traces：`/mcp/<MCP_ACCESS_KEY>` 的路径本身就是管理密钥；只删 query string 不足以保护它。代码不输出 URL、认证头、verifier、请求/响应体、凭据名称或异常内容。应用级测试只验证自定义日志字段；部署后仍应使用无秘密的请求检查 Cloudflare 实际收集的元数据，不能将其当作平台端日志脱敏保证。实时 tail、其他 Logpush 配置和历史日志不受这项配置保护。

本配置需随代码重新部署才生效。保留实际部署配置中的 D1 database_id 和 secrets，不要用仓库占位值覆盖生产绑定。若已连接 Workers Builds，检查对应提交的构建/部署结果；否则运行 `npm run cf:deploy`。GitHub push 本身不证明生产部署成功。

日志不追溯启用前的请求，也无法记录到达 Worker 前的 DNS/TLS/网络失败。这里的 `status` 是 HTTP 状态；MCP 工具错误可能包装在 HTTP 200 中，不应据此认定工具成功。日志按 Cloudflare 账户套餐计费。

### 终端 helper 失败诊断

0.5.1 helper 在网络或非 2xx HTTP 失败时，将安全诊断输出到 stderr：curl 退出码、UTC Unix 秒级开始/结束时间、经过秒数、HTTP 状态，以及 curl 的 DNS/连接/TLS/首字节/总耗时。响应存在且格式严格有效时，还包括最后一个 HTTP 响应块的 CF-Ray 与 UUID 格式 X-Request-ID。缺失的字段不代表服务端已收到请求；HTTP 000 不是服务端状态码。

不会输出原始 curl 错误、URL、认证头、请求/响应体、Token 或 proof；成功时保持静默，不影响子命令 stdout/退出码。不能把 `/mcp` 的 200 当作 `/redeem/read` 领取成功，也不能由公开 helper GET 成功推断领取 POST 一定可达。curl 28 可能发生在连接或整体传输阶段，结合耗时定位，不自动重试同一链接。

更新 helper 后需一并更新服务端公开 helper 和插件内 SHA-256 校验文件；仓库提供 `npm run build` / `npm run plugin:build`，不要绕过版本校验。此修改不改变网络设置、超时、重试或凭据授权。

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
| `create_token_envelope` | 将指定凭据加密给本地临时公钥 |
| `get_cli_helper` | 通过 MCP 获取固定公开解密 helper |
| `delete_token` | 删除金库记录并作废待领取链接 |
| `recent_activity` | 查看最近活动，不含 Token、secret 或领取链接 |

读取：`node vault-envelope.mjs prepare` 生成本地私钥及公开请求 → MCP `create_token_envelope` → 同 helper `run -- command args` 从 stdin 接收密文并执行。详见下方及 Skill。

上传：`sh vault-cli.sh prepare` → MCP `create_token_write_link` → 同 shell helper `store` 上传环境变量中的凭据。不要 source 脚本或状态文件。

Agent 上传时，Token 必须已在执行 `store` 的进程环境中；个人终端的变量不会自动出现在云端 Agent 中。首次保存也可由你使用下方手动接口完成，不发到聊天。同名覆盖需用户授权和 `overwrite:true`，可同时修改环境变量名。成功领取后，Token 仅注入指定命令及其子进程；不修改父 Shell、不执行持久登录。

上传链接需要 `name`、`claimChallenge` 和 `envVar`，覆盖时再加 `overwrite:true`；无需服务分类、用途说明或允许领取的开关。`list_tokens` 仅返回凭据名称、环境变量名和更新时间。

## 用户手动上传：一次请求

**此接口仅供用户在自己的终端手动使用，AI Agent 不应调用、代运行或读取其中的私密文件。** 它不在 MCP 工具列表中，SKILL 也明确禁止 Agent 使用；同一密钥无法从技术上证明操作者是人，这不是服务端的人机身份隔离。

```text
POST https://YOUR_VAULT_HOST/admin/tokens
Authorization: Bearer <MCP_ACCESS_KEY>
Content-Type: application/json
```

请求体为：

```json
{"name":"github/main","envVar":"GH_TOKEN","token":"在自己的本地文件里填写真实 Token","overwrite":false}
```

无需 `prepare`、`claimChallenge` 或一次性链接。已有同名记录时，设置 `overwrite:true` 才会覆盖。成功仅返回 `{"stored":true}`，不回显 Token；所有成功保存的凭据立即可供 Agent 领取。缺失或错误管理密钥返回 401，未授权覆盖返回 409。

### 用上传脚本新建或更新

脚本是 [cli/vault-upload.sh](cli/vault-upload.sh)，仅供用户手动执行，不随 Agent 插件打包。需要 POSIX `sh`、curl 7.55+、awk、stty、mktemp 和常见 Unix 工具，无需 Node、Python 或 jq。必须在有交互终端的本机或服务器执行，不要通过 Agent 代运行。

已克隆仓库时，在仓库目录运行：

```sh
# 新建：记录名称 openai/main，使用时注入 OPENAI_API_KEY
sh cli/vault-upload.sh --origin https://YOUR_VAULT_HOST openai/main OPENAI_API_KEY

# 更新：替换 github/main 的 Token，并保留 GH_TOKEN 作为环境变量名
sh cli/vault-upload.sh --origin https://YOUR_VAULT_HOST github/main GH_TOKEN --overwrite
```

把域名替换成你自己的 HTTPS origin，不带路径或末尾斜杠；名称和环境变量按需修改。脚本没有默认服务地址，避免误传到别人的金库。不加 `--overwrite` 时只允许新建，同名记录返回 409。

不需要克隆项目或预先安装 helper。升级后的 Vault 在**相同 HTTPS origin 的 `/vault-upload.sh`** 提供免认证的静态脚本下载；下载不需要管理密钥，不会读取或写入凭据。`/admin/tokens` 的认证要求不变。`/health` 正常但此路径返回 404，通常表示尚未部署包含该路由的新版 Worker；不要去掉下载命令的失败检查。

先从你信任的发布版本或已审阅文档确认 SHA-256，再下载、校验并由本人执行，禁止 `curl | sh`。本版脚本未改动，可信比对值为 `e52a6d390f78a9f1dbf0603985b89a8dfb03d5654ea2b10d99125a57bc7ba3ac`，对应 [已固定的脚本源码](https://github.com/Hanssen0-Alter-Ego/token-vault-mcp/blob/b3dbca38c4520876ce3aca540b2803b94026a167/cli/vault-upload.sh)。不要把下载服务器同时返回的 hash 当作独立信任依据；升级后 hash 不同，先审阅新版脚本及可信发布记录，不要跳过校验。

在自己的交互终端执行（下面另需 `sha256sum`，不需要 `chmod +x`）：

```sh
(
  set -eu
  umask 077
  origin=https://YOUR_VAULT_HOST
  download_dir=$(mktemp -d)
  trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
  curl -q --fail --silent --show-error --proto '=https' \
    --connect-timeout 10 --max-time 30 \
    -o "$download_dir/vault-upload.sh" "$origin/vault-upload.sh"
  printf '%s  %s\n' \
    e52a6d390f78a9f1dbf0603985b89a8dfb03d5654ea2b10d99125a57bc7ba3ac \
    "$download_dir/vault-upload.sh" | sha256sum --check --status
  sh "$download_dir/vault-upload.sh" --origin "$origin" openai/main OPENAI_API_KEY
)
```

`sh` 仍然是执行脚本所需的系统 shell，并非需要另行安装的 Vault helper。只有在校验成功后脚本才会提示输入密钥；下载不跟随跨站重定向。要替换已有凭据，在最后一条 `sh` 命令末尾显式添加 `--overwrite`。
运行时依次隐藏输入金库的 `MCP_ACCESS_KEY` 和要保存的单行业务 Token。无需把密钥写进命令、设置环境变量或先申请链接；成功显示 `{"stored":true}`。认证头和 JSON 请求体通过 0600 私有临时文件传递，正常完成或请求失败后都会清理；脚本还会恢复终端回显。强制终止或系统崩溃时，临时文件可能残留。

认证失败返回 401；新建时遇到重名返回 409，请确认后用 `--overwrite` 再次运行。不要向聊天发送密钥、临时文件或带密钥的连接 URL。

此接口只接受 Bearer 请求头认证，不接受路径或 query 中的密钥，也不开放跨站浏览器调用。Agent 的上传仍走 MCP 签发链接和终端 secret 校验流程。

## 安全与错误处理

- 一次性领取/上传接口：**403** 表示 secret 缺失或错误，有效链接不消费；**410** 表示链接失效、过期或已用。每次失败后重新 prepare 并申请链接，禁止回退到无 secret 领取。
- helper 使用私有临时文件向 curl 传递认证头和上传体，不把凭据写入命令参数；启动目标 CLI 前清理 state。预检失败或进程中断可能留文件，在本地删除，不回显内容。
- 覆盖或删除会作废旧链接；删除记录不会撤销服务商 Token，链接过期不会终止已经取得 Token 的进程。
- secret 绑定防止仅凭对话链接抢领，不能防御被控制的终端、泄露的 MCP 管理密钥或恶意托管方。金库与 HTTPS 终止方仍可见明文 Token。
- 数据库以 AES-256-GCM 保存 Token、仅保存领取码哈希。不要随意更换加密密钥；不要启用 shell tracing 或记录私密 MCP 路径、认证头、请求/响应体。

## 更新已有部署

保留 `.env`、Worker 名称、D1 ID 和 secrets：

```sh
git pull --ff-only
npm ci
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy --keep-vars
npm run plugin:build
```

Docker 部署只需拉取代码后运行 `docker compose up -d --build`，启动时自动迁移，不用运行 Wrangler。更新插件中的 SKILL 和配套文件；已有可用的 App 连接无需重建。

**升级到 0.5.0 必须应用 `0002_simplify_credentials.sql`。** 它删除允许领取开关、服务分类、用途和固定审计字段；保留已有凭据的 ID、加密内容及活动记录，不重置密钥。原先禁止 Agent 领取的记录也会变为可领取。未完成的一次性链接会清理，重新申请即可。

Cloudflare 先迁移再部署，两步之间旧服务可能短暂不可用；请连续完成。迁移后不要直接运行旧版服务。0.5.0 的 helper 沿用当时的 sh 脚本，哈希不变；0.7.0 上传 helper 的新 hash 见下文。新增手动上传接口不会改变 Agent 的一次性链接流程。

## 开发检查

```sh
npm test
npm run typecheck
npm run build
npx wrangler deploy --dry-run
```

测试使用随机/合成凭据，覆盖 MCP SDK、认证、脚本真实 HTTPS 上传和领取、环境注入、临时文件清理、错误 secret、单次消费、过期/重放、覆盖/删除、手动上传认证、旧数据库升级和打包。包含无 Node/Python/jq/Bash 的 helper 运行测试；不会验证真实服务商 Token 或各产品的终端能力。

## Encrypted credential delivery

For every credential read, the
`create_token_envelope` tool returns a compact JWE (`RSA-OAEP-256` / `A256GCM`)
for a fresh locally generated RSA-3072 public key. The fixed, dependency-free
`cli/vault-envelope.mjs` helper requires Node 24+, makes no network requests,
and injects the decrypted credential only into the requested child process.
It never sources a script or evaluates returned content. The POSIX shell helper
retains only prepare/store for uploading credentials.

Apply migration `0003_envelope_issuance.sql`, upgrade the server, rebuild/update
the plugin and refresh its tools before use. The plugin packages both helpers
and their SHA-256 integrity manifests. See its Skill for prepare/run commands.
No additional provider permissions or persistent credential storage are needed.

The authenticated MCP gate authorizes release; the public key is validated and
bound to the request, not attested. Use only the public request produced by the
trusted local helper. Issuance is limited to 20 per owner per minute, duplicate
request/key metadata is retained for five minutes, and successful release is
audited as `read.envelope_issued` before any ciphertext is returned. Plaintext,
private keys and ciphertext are not written to the audit database.

Ciphertext and public metadata may appear in tool/chat records. They are not a
secret-free artifact: protect the matching local private key. Envelopes cannot
be recalled after issuance. The 60-second expiry and one-use state consumption
are helper controls, not cryptographic expiration or server-enforced redemption.
A retained private key can decrypt retained ciphertext later, even after Vault
deletion. Provider revocation/expiration remains necessary to invalidate the
credential itself. Public-key encryption does not independently authenticate
the sender; this flow trusts the authenticated MCP response. It does not protect
against a compromised local agent, host or child program. Private-state deletion
is best-effort cleanup, not guaranteed erasure from disk or JavaScript memory.

### Obtain the offline helper through MCP

`get_cli_helper({})` returns the fixed public `vault-envelope.mjs` source, filename,
version and SHA-256. It needs no executor-to-Vault network access and never generates
or returns a private key or credential. Save `source` as UTF-8 **data**, compare its
SHA-256 with the independently trusted Skill's `envelope-helper-integrity.json`,
then explicitly run `node vault-envelope.mjs`. Do not `eval`, `source`, pipe it to
an interpreter, or treat a hash supplied alongside untrusted code as independent
verification. Prefer the already packaged helper when available. The script itself
may appear in tool history; ephemeral keys are generated only on the local host.

### Cloudflare upgrade without an existing source checkout

The Worker cannot rebuild itself. Use a temporary checkout on a Node 24 computer
(or Cloudflare's supported Git-connected Workers Builds) rather than Docker.
Clone this repository, run `npm ci`, and configure `wrangler.jsonc` with the
**existing** Worker's name, account, actual D1 `database_id`, routes/custom domain,
and `PUBLIC_ORIGIN`. Do not deploy the placeholder database ID or create a new DB.
After `npx wrangler whoami` confirms the correct account:

```sh
npx wrangler d1 migrations apply DB --remote
npm run build
npx wrangler deploy --keep-vars
```

Keep existing MCP and encryption secrets unchanged. Do not run `npm run init` or
`npm run cf:secrets` for this upgrade. Refresh the MCP tools and update the packaged
Skill after deployment. Repository publication alone does not deploy the Worker.

### 0.7.0: retire legacy reads

`create_token_read_link` and `vault-cli.sh run` are removed. `/redeem/read`
returns 410 without accessing credentials, including for previously issued links.
Migrate callers to encrypted envelopes before deployment. There are six MCP tools.
No additional database migration or credential re-encryption is needed when
upgrading from 0.6.1; existing write grants and stored data remain compatible.
The upload helper hash changes: update its trusted Skill together with the server.
The envelope helper/hash is unchanged. Never run initialization or regenerate keys.
