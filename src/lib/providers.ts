export const providers = [
  { id: "github", name: "GitHub", envVar: "GH_TOKEN", color: "#24292f", hint: "PAT 或 gh CLI token" },
  { id: "openai", name: "OpenAI", envVar: "OPENAI_API_KEY", color: "#14866d", hint: "API key" },
  { id: "anthropic", name: "Anthropic", envVar: "ANTHROPIC_API_KEY", color: "#b56d4c", hint: "API key" },
  { id: "notion", name: "Notion", envVar: "NOTION_TOKEN", color: "#333333", hint: "Integration token" },
  { id: "slack", name: "Slack", envVar: "SLACK_TOKEN", color: "#6a376b", hint: "Bot 或 user token" },
  { id: "linear", name: "Linear", envVar: "LINEAR_API_KEY", color: "#5e6ad2", hint: "Personal API key" },
  { id: "stripe", name: "Stripe", envVar: "STRIPE_API_KEY", color: "#635bff", hint: "Secret 或 restricted key" },
  { id: "cloudflare", name: "Cloudflare", envVar: "CLOUDFLARE_API_TOKEN", color: "#e78b34", hint: "API token" },
  { id: "other", name: "其他服务", envVar: "SERVICE_TOKEN", color: "#58666d", hint: "Token / API key" },
] as const;
export function providerFor(id: string) { return providers.find(p => p.id === id); }
