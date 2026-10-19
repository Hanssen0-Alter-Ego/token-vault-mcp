export const providers = [
  { id: "github", name: "GitHub" },
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "notion", name: "Notion" },
  { id: "slack", name: "Slack" },
  { id: "linear", name: "Linear" },
  { id: "stripe", name: "Stripe" },
  { id: "cloudflare", name: "Cloudflare" },
  { id: "other", name: "其他服务" },
] as const;
export function providerFor(id: string) { return providers.find(p => p.id === id); }
