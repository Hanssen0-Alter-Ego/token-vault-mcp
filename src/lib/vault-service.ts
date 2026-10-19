import {CLI_SHA256} from "./cli-integrity";
import { AppError, validateName, validateSecret, validateEnvVar, encryptSecret, decryptSecret, redemptionOrigin, newTicket, ticketHash, validateClaimChallenge, verifierChallenge } from "./security";
import { providerFor } from "./providers";
type Row = { id: string; user_id: string; name: string; provider: string; env_var: string; encrypted_token: string; allow_agent_use: number; revision: string; created_at: string; updated_at: string };
type Input = { name: string; provider: string; envVar: string; token?: string; allowAgentUse: boolean; overwrite?: boolean };
type Grant = { hash: string; user_id: string; name: string; kind: "read" | "write"; config: string; purpose: string; expires_at: number; used_at: number | null };
export class VaultService {
  constructor(private db: D1Database, private key: string | undefined, private origin?: string, private clock = () => Date.now()) {}
  metadata(row: Row) { return { id: row.id, name: row.name, provider: row.provider, service: providerFor(row.provider)?.name || row.provider, envVar: row.env_var, allowAgentUse: !!row.allow_agent_use, updatedAt: row.updated_at }; }
  async list(user: string) { return (await this.db.prepare("SELECT * FROM credentials WHERE user_id = ? ORDER BY name").bind(user).all<Row>()).results.map(row => this.metadata(row)); }
  async recent(user: string) { return (await this.db.prepare("SELECT credential_name AS credentialName, action, destination, status, created_at AS createdAt FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 40").bind(user).all()).results; }
  private record(user: string, name: string) { return this.db.prepare("SELECT * FROM credentials WHERE user_id = ? AND name = ?").bind(user, validateName(name)).first<Row>(); }
  private audit(user: string, name: string, action: string, status = 200) { return this.db.prepare("INSERT INTO activity (id,user_id,credential_name,action,destination,status,created_at) VALUES (?,?,?,?,?,?,?)").bind(crypto.randomUUID(), user, name, action, "vault", status, new Date(this.clock()).toISOString()); }
  private fields(input: Input) {
    validateName(input.name); validateEnvVar(input.envVar);
    if (!providerFor(input.provider)) throw new AppError("请选择支持的服务分类。");
    if (typeof input.allowAgentUse !== "boolean") throw new AppError("请选择是否允许 Agent 领取。");
    if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") throw new AppError("overwrite 必须为布尔值。");
  }
  async save(user: string, input: Input, expectedRevision?: string) {
    this.fields(input);
    const existing = await this.record(user, input.name);
    if (existing && input.overwrite !== true) throw new AppError("同名凭据已存在；覆盖需要明确设置 overwrite=true。", 409);
    if (expectedRevision !== undefined && (existing?.revision || "absent") !== expectedRevision) throw new AppError("凭据已发生变化，请重新创建写入链接。", 409);
    if (!existing && (await this.list(user)).length >= 100) throw new AppError("金库最多保存 100 份凭据。");
    const token = input.token ? validateSecret(input.token) : null;
    if (!existing && !token) throw new AppError("首次保存需要 token。");
    const id = existing?.id || crypto.randomUUID(), revision = crypto.randomUUID(), now = new Date(this.clock()).toISOString();
    const encrypted = token ? await encryptSecret(token, `${user}:${id}`, this.key) : existing!.encrypted_token;
    const result = await this.db.batch([
      this.db.prepare("INSERT INTO credentials (id,user_id,name,provider,env_var,encrypted_token,allow_agent_use,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,name) DO UPDATE SET provider=excluded.provider,env_var=excluded.env_var,encrypted_token=excluded.encrypted_token,allow_agent_use=excluded.allow_agent_use,revision=excluded.revision,updated_at=excluded.updated_at WHERE credentials.revision = ? RETURNING *").bind(id,user,input.name,input.provider,input.envVar,encrypted,input.allowAgentUse ? 1 : 0,revision,existing?.created_at || now,now,existing?.revision || "absent"),
      this.db.prepare("INSERT INTO activity (id,user_id,credential_name,action,destination,status,created_at) SELECT ?,?,?,?,'vault',200,? WHERE EXISTS(SELECT 1 FROM credentials WHERE user_id=? AND name=? AND revision=?)").bind(crypto.randomUUID(),user,input.name,existing ? "credential.updated" : "credential.created",now,user,input.name,revision),
      this.db.prepare("DELETE FROM handoffs WHERE user_id=? AND name=? AND EXISTS(SELECT 1 FROM credentials WHERE user_id=? AND name=? AND revision=?)").bind(user,input.name,user,input.name,revision),
    ]);
    const row = result[0].results[0] as Row | undefined;
    if (!row) throw new AppError("凭据已发生变化，请重试。", 409);
    return this.metadata(row);
  }
  async remove(user: string, name: string) {
    validateName(name);
    await this.db.batch([this.db.prepare("DELETE FROM credentials WHERE user_id=? AND name=?").bind(user,name), this.db.prepare("DELETE FROM handoffs WHERE user_id=? AND name=?").bind(user,name), this.audit(user,name,"credential.removed")]);
    return { removed: true };
  }
  async issue(user: string, kind: "read" | "write", input: Input & { purpose?: string; claimChallenge?: string }) {
    const origin = redemptionOrigin(this.origin), name = validateName(input.name);
    const purpose = input.purpose;
    const claimChallenge = validateClaimChallenge(input.claimChallenge);
    if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 240 || /[\r\n\0]/.test(purpose)) throw new AppError("请填写简短的用途说明，不要包含凭据。");
    const existing = await this.record(user, name);
    let config: object;
    if (kind === "read") {
      if (!existing) throw new AppError("找不到凭据。",404);
      if (!existing.allow_agent_use) throw new AppError("此凭据未开启 Agent 领取。",403);
      config = { claimChallenge, revision: existing.revision, envVar: existing.env_var };
    } else {
      this.fields(input);
      if (existing && input.overwrite !== true) throw new AppError("同名凭据已存在，覆盖需要 overwrite=true。",409);
      config = { claimChallenge, name, provider: input.provider, envVar: input.envVar, allowAgentUse: input.allowAgentUse, overwrite: input.overwrite === true, revision: existing?.revision || "absent" };
    }
    const now = this.clock();
    await this.db.prepare("DELETE FROM handoffs WHERE expires_at <= ?").bind(now).run();
    const pending = await this.db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE user_id=? AND used_at IS NULL").bind(user).first<{n:number}>();
    if ((pending?.n || 0) >= 20) throw new AppError("未使用的领取链接过多，请稍后再试。",429);
    const ticket = newTicket(), hash = await ticketHash(ticket), expires = now + 60000;
    await this.db.batch([this.db.prepare("INSERT INTO handoffs(hash,user_id,name,kind,config,purpose,expires_at) VALUES(?,?,?,?,?,?,?)").bind(hash,user,name,kind,JSON.stringify(config),purpose.trim(),expires),this.audit(user,name,`${kind}.link_issued`)]);
    return { url: `${origin}/redeem/${kind}#${ticket}`, method: "POST", helper: { url: `${origin}/vault-cli.mjs`, sha256: CLI_SHA256 }, expiresAt: new Date(expires).toISOString(), oneTime: true, proofRequired: true, proofMethod: "S256", envVar: kind === "read" ? existing!.env_var : input.envVar, instruction: "Sensitive one-time link. The matching terminal-held verifier is mandatory; never send it through MCP or chat. Use the CLI helper immediately; fragment is the Bearer claim, never send the fragment in a query/path. Do not print the response, enable tracing, or store the token. A lost response requires a fresh link. This link does not expire the provider token or stop a process that already received it." };
  }
  async redeem(kind: "read" | "write", ticket: string, token?: unknown, verifier?: unknown) {
    // Validate upload before claiming; malformed uploads must never overwrite a saved credential.
    const secret = kind === "write" ? validateSecret(token) : undefined;
    const hash = await ticketHash(ticket), now = this.clock();
    const challenge = await verifierChallenge(verifier);
    // Compare the bound proof and consume in the same atomic statement. Wrong proofs never burn the grant.
    const grant = challenge ? await this.db.prepare("UPDATE handoffs SET used_at=? WHERE hash=? AND kind=? AND used_at IS NULL AND expires_at>? AND json_extract(config, '$.claimChallenge')=? RETURNING *").bind(now,hash,kind,now,challenge).first<Grant>() : null;
    if (!grant) {
      const pending = await this.db.prepare("SELECT user_id,name FROM handoffs WHERE hash=? AND kind=? AND used_at IS NULL AND expires_at>?").bind(hash,kind,now).first<{user_id:string;name:string}>();
      if (pending) {
        await this.audit(pending.user_id,pending.name,`${kind}.proof_rejected`,403).run();
        throw new AppError("领取 secret 缺失或不匹配；链接未被消费。",403);
      }
      throw new AppError("领取链接无效、已使用或已过期。",410);
    }
    const config = JSON.parse(grant.config);
    if (kind === "write") return this.save(grant.user_id, {...config,token:secret},config.revision);
    const row = await this.record(grant.user_id,grant.name);
    if (!row || !row.allow_agent_use || row.revision !== config.revision) throw new AppError("凭据已变更，链接失效。",410);
    const value = await decryptSecret(row.encrypted_token,`${grant.user_id}:${row.id}`,this.key);
    // Fail closed if auditing fails: never return plaintext before the audit record is durable.
    await this.audit(grant.user_id,grant.name,"read.redeemed").run();
    return { token:value, envVar:row.env_var };
  }
}
