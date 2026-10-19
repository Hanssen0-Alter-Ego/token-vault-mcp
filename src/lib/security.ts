export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function assertSameOrigin(request: Request, configured?: string) {
  const origin = request.headers.get("origin"), allowed = new Set([new URL(request.url).origin]);
  if (configured) allowed.add(new URL(configured).origin);
  if (!origin || !allowed.has(origin)) throw new AppError("请求来源不匹配，请刷新页面。", 403);
}
export function validateName(name: unknown): string {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_/-]{0,63}$/.test(name) || name.includes("//") || name.endsWith("/")) throw new AppError("凭据名称使用小写字母、数字、下划线、短横线或斜杠，以字母开头。");
  return name;
}
export function validateSecret(secret: unknown): string {
  if (typeof secret !== "string" || !secret.trim() || secret.length > 8192 || /[\r\n\0]/.test(secret)) throw new AppError("请输入有效的 token，不要包含换行。");
  if (/^Bearer\s/i.test(secret.trim())) throw new AppError("请只填写 token，不要添加 Bearer 前缀。");
  return secret.trim();
}
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function keyFrom(secret?: string) {
  if (!secret) throw new AppError("金库加密服务尚未就绪。", 503);
  const bytes = decode(secret);
  if (bytes.length !== 32) throw new AppError("金库加密配置无效。", 503);
  return crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encryptSecret(secret: string, identity: string, key?: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`vault-v1:${identity}`) }, await keyFrom(key), new TextEncoder().encode(secret));
  return JSON.stringify({ v: 1, iv: encode(iv), ciphertext: encode(new Uint8Array(data)) });
}
export async function decryptSecret(envelope: string, identity: string, key?: string) {
  const data = JSON.parse(envelope);
  if (data.v !== 1) throw new AppError("凭据版本不兼容。", 503);
  const result = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(data.iv) as BufferSource, additionalData: new TextEncoder().encode(`vault-v1:${identity}`) }, await keyFrom(key), decode(data.ciphertext) as BufferSource);
  return new TextDecoder().decode(result);
}
export async function readLimited(stream: ReadableStream<Uint8Array> | null, maxBytes = 524288) {
  if (!stream) return "";
  const reader = stream.getReader(), decoder = new TextDecoder();
  let count = 0, text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      count += result.value.length;
      if (count > maxBytes) throw new AppError("内容超过大小限制，请缩小范围或分页。", 413);
      text += decoder.decode(result.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export async function readJSON(request: Request, max = 262144): Promise<any> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) throw new AppError("请使用 JSON 请求。", 415);
  try { return JSON.parse(await readLimited(request.body, max)); }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError("JSON 格式无效。"); }
}

export function validateEnvVar(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value) || /^(PATH|HOME|SHELL|ENV|BASH_ENV|IFS|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|LD_.*|DYLD_.*)$/.test(value)) throw new AppError("请输入专用于凭据的环境变量名称，例如 GH_TOKEN。");
  return value;
}
export function redemptionOrigin(value?: string): string {
  if (!value) throw new AppError("一次性领取入口尚未部署，请先连接 Cloudflare 或服务器入口。", 503);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new AppError("领取入口配置无效。", 503);
  return url.origin;
}
export function newTicket() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join(""); }
export async function ticketHash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new AppError("领取链接无效或已失效。", 410);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}
