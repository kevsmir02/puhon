import { cn } from "@/lib/utils";
import { displayAgent } from "./format";

const COLORS: Record<string, string> = {
  claude: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  codex: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  pi: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  opencode: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  antigravity: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
};

export function AgentIcon({
  agent,
  size = 16,
  className,
}: {
  agent: string;
  size?: number;
  className?: string;
}) {
  const key = agent.toLowerCase();
  const color = COLORS[key] ?? "bg-muted text-muted-foreground";
  const label = displayAgent(agent);
  const initial = label.charAt(0);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold",
        color,
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.55) }}
      aria-hidden
    >
      {initial}
    </span>
  );
}
