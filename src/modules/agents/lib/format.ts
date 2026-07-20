const LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  agy: "Antigravity",
  gemini: "Antigravity",
};

export function displayAgent(agent: string): string {
  if (!agent) return "Agent";
  return LABELS[agent.toLowerCase()] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}
