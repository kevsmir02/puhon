import type { Tab } from "@/modules/tabs";
import { hasLeaf, leafIdForPty } from "@/modules/terminal";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { displayAgent } from "@/modules/agents/lib/format";
import { routeAgentNotification } from "@/modules/agents/lib/route";
import type { AgentSession, AgentSignal } from "@/modules/agents/lib/types";
import { useWindowFocus } from "@/modules/agents/lib/useWindowFocus";
import { useAgentStore } from "@/modules/agents/store/agentStore";

type Activate = (tabId: number, leafId: number) => void;
type UpdateTab = (id: number, patch: Partial<Tab>) => void;
type PreviewUrlEvent = { pty_id: number; url: string };

type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  updateTab: UpdateTab;
};

function tabInfo(tabs: Tab[], leafId: number): { tabId: number; title: string } | null {
  for (const t of tabs) {
    if (t.kind === "terminal" && hasLeaf(t.paneTree, leafId)) {
      return { tabId: t.id, title: t.title };
    }
  }
  return null;
}

function route(
  session: AgentSession,
  kind: "attention" | "finished",
  ctx: Ctx,
): void {
  const info = tabInfo(ctx.tabs, session.leafId);
  const name = displayAgent(session.agent);
  const heading =
    kind === "attention" ? `${name} needs your input` : `${name} finished`;

  routeAgentNotification({
    agent: session.agent,
    kind,
    title: heading,
    body: info?.title,
    focused: ctx.focused,
    visible: ctx.activeId === session.tabId,
    allowToast: kind === "attention",
    tabId: session.tabId,
    leafId: session.leafId,
    onActivate: () => ctx.onActivate(session.tabId, session.leafId),
  });
}

function handleSignal(sig: AgentSignal, ctx: Ctx): void {
  const leafId = leafIdForPty(sig.id);
  if (leafId === null) return;
  const store = useAgentStore.getState();

  switch (sig.kind) {
    case "started": {
      const info = tabInfo(ctx.tabs, leafId);
      if (!info) return;
      store.start(leafId, info.tabId, sig.agent ?? "agent");
      return;
    }
    case "working":
      store.setStatus(leafId, "working");
      return;
    case "attention": {
      store.setStatus(leafId, "waiting");
      const session = store.sessions[leafId];
      if (session) route(session, "attention", ctx);
      return;
    }
    case "finished": {
      store.setStatus(leafId, "waiting");
      const session = store.sessions[leafId];
      if (session) route(session, "finished", ctx);
      return;
    }
    case "exited": {
      store.finish(leafId);
      const info = tabInfo(ctx.tabs, leafId);
      if (info) {
        const tab = ctx.tabs.find((t) => t.id === info.tabId);
        if (tab?.kind === "terminal" && tab.previewUrl) {
          ctx.updateTab(tab.id, { previewUrl: undefined } as Partial<Tab>);
        }
      }
      return;
    }
  }
}

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
  updateTab,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
  updateTab: UpdateTab;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({ tabs, activeId, focused, onActivate, updateTab });
  ctxRef.current = { tabs, activeId, focused, onActivate, updateTab };

  useEffect(() => {
    let alive = true;
    let unlistenSignal: (() => void) | undefined;
    let unlistenUrl: (() => void) | undefined;

    listen<AgentSignal>("puhon:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
    )
      .then((u) => {
        if (alive) unlistenSignal = u;
        else u();
      })
      .catch(() => {});

    listen<PreviewUrlEvent>("puhon:preview-url", (e) => {
      const leafId = leafIdForPty(e.payload.pty_id);
      if (leafId === null) return;
      const info = tabInfo(ctxRef.current.tabs, leafId);
      if (!info) return;
      ctxRef.current.updateTab(info.tabId, { previewUrl: e.payload.url } as Partial<Tab>);
    })
      .then((u) => {
        if (alive) unlistenUrl = u;
        else u();
      })
      .catch(() => {});

    return () => {
      alive = false;
      unlistenSignal?.();
      unlistenUrl?.();
    };
  }, []);

  return null;
}
