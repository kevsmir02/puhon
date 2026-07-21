import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Tab, TerminalTab } from "@/modules/tabs";
import { labelFor } from "@/modules/tabs/lib/tabLabel";
import {
  Cancel01Icon,
  Globe02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";

type Props = {
  tabs: Tab[];
  activeId: number;
  onOpenPreview: (url: string, spaceId: string) => void;
  onDismiss: () => void;
};

/** Tabs that have a detected localhost URL, with stable order. */
function tabsWithUrls(tabs: Tab[]): TerminalTab[] {
  return tabs.filter(
    (t): t is TerminalTab =>
      t.kind === "terminal" && t.previewUrl !== undefined,
  );
}

export function PreviewUrlPill({
  tabs,
  activeId,
  onOpenPreview,
  onDismiss,
}: Props) {
  const urls = useMemo(() => tabsWithUrls(tabs), [tabs]);

  if (urls.length === 0) return null;

  const activeHasUrl = urls.some((t) => t.id === activeId);
  const primary = urls[urls.length - 1];

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() =>
          onOpenPreview(primary.previewUrl!, primary.spaceId)
        }
        title={`Open ${primary.previewUrl}`}
      >
        <HugeiconsIcon
          icon={Globe02Icon}
          size={13}
          strokeWidth={1.75}
          className={activeHasUrl ? "text-green-500" : "text-primary"}
        />
        <span className="max-w-32 truncate">
          {primary.previewUrl!.replace(/^https?:\/\//, "")}
        </span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground"
          >
            <svg
              viewBox="0 0 10 6"
              className="size-2.5"
              fill="currentColor"
            >
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="bottom"
          sideOffset={6}
          className="min-w-56 rounded-xl border border-border/40 bg-popover/90 p-1 backdrop-blur-md shadow-lg"
        >
          {urls.map((t) => (
            <DropdownMenuItem
              key={`${t.id}-${t.previewUrl}`}
              onSelect={() => onOpenPreview(t.previewUrl!, t.spaceId)}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
            >
              <HugeiconsIcon
                icon={Globe02Icon}
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-green-500"
              />
              <div className="flex flex-1 flex-col min-w-0">
                <span className="truncate font-medium">{labelFor(t)}</span>
                <span className="truncate text-[10px] text-muted-foreground">
                  {t.previewUrl}
                </span>
              </div>
              {t.id === activeId && (
                <span className="text-[10px] text-muted-foreground">active</span>
              )}
            </DropdownMenuItem>
          ))}
          <div className="my-1 border-t border-border/30" />
          <DropdownMenuItem
            onSelect={onDismiss}
            className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground text-muted-foreground"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              size={13}
              strokeWidth={1.75}
              className="shrink-0"
            />
            <span>Dismiss all</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
