import { useBlockController } from "@/modules/terminal/lib/blockController";
import { useTheme } from "@/modules/theme";
import {
  CommandLineIcon,
  Folder01Icon,
  GitBranchIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { OsIcon } from "./OsIcon";
import { useGitBranch } from "./useGitBranch";
import { useSystemInfo } from "./useSystemInfo";

const ShellInput = lazy(() => import("@/modules/terminal/block/ShellInput"));

export const TOGGLE_BLOCK_INPUT_EVENT = "terax:toggle-block-input";

type Props = {
  isBlockTab: boolean;
  isTerminalTab: boolean;
  activeLeafId: number | null;
  cwd: string | null;
  home: string | null;
};

export function WorkspaceInputBar({
  isBlockTab,
  isTerminalTab,
  activeLeafId,
  cwd,
  home,
}: Props) {
  const { resolvedMode, themeId, customThemes } = useTheme();
  const themeKey = `${resolvedMode}:${themeId}:${customThemes.length}`;
  const { os, shell } = useSystemInfo();

  const controller = useBlockController(isBlockTab ? activeLeafId : null);
  const blockMode = controller?.blockMode ?? "prompt";

  // Re-resolve the branch chip when a command finishes (covers `git checkout`).
  const [promptNonce, setPromptNonce] = useState(0);
  const prevBlockMode = useRef(blockMode);
  useEffect(() => {
    if (prevBlockMode.current !== "prompt" && blockMode === "prompt") {
      setPromptNonce((n) => n + 1);
    }
    prevBlockMode.current = blockMode;
  }, [blockMode]);
  const branch = useGitBranch(isTerminalTab ? cwd : null, promptNonce);

  if (!isBlockTab) return null;

  const terminalChips = isTerminalTab ? (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      {os && (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5">
          <OsIcon os={os} />
          <span>{os}</span>
        </span>
      )}
      {cwd && (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-blue-600 dark:text-blue-400">
          <HugeiconsIcon icon={Folder01Icon} size={11} strokeWidth={1.75} />
          <span>{relPath(cwd, home)}</span>
        </span>
      )}
      {branch && (
        <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-violet-600 dark:text-violet-400">
          <HugeiconsIcon icon={GitBranchIcon} size={11} strokeWidth={1.75} />
          <span>{branch}</span>
        </span>
      )}
      {shell && (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-600 dark:text-emerald-400">
          <HugeiconsIcon icon={CommandLineIcon} size={11} strokeWidth={1.75} />
          <span>{shell}</span>
        </span>
      )}
    </div>
  ) : null;

  const content = isBlockTab ? (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <div className="flex flex-col gap-2 rounded-lg px-1 py-1">
        {terminalChips}
        <div className="flex items-end gap-2.5">
          <div className="relative min-w-0 flex-1">
            {controller && activeLeafId != null && (
              <Suspense fallback={null}>
                <ShellInput
                  leafId={activeLeafId}
                  mode={blockMode}
                  focused={true}
                  themeKey={themeKey}
                  onSubmit={controller.submitCommand}
                  onInterrupt={controller.interrupt}
                  getCwd={controller.getCwd}
                />
              </Suspense>
            )}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  if (!content) return null;

  return (
    <div data-state="open" className="terax-reveal">
      <div>{content}</div>
    </div>
  );
}

function relPath(p: string, home: string | null): string {
  if (!home) return p;
  const h = home.replace(/\/+$/, "");
  if (p === h || p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}
