# Agent-awareness - Plan 3: Frontend module (terminal-source only)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `src/modules/agents/` frontend module that listens for `puhon:agent-signal` events from Plan 1, drives per-leaf agent session state, and surfaces attention/finished events through an in-app bell, a toast, and OS notifications when the tab is hidden. Includes a Settings toggle (default on) and the per-agent "Enable" controls that call the install commands from Plan 2.

**Architecture:** A zustand store holds per-leaf sessions and a capped notification list. An `AgentNotificationsBridge` component (mounted once, renders nothing) subscribes to the Tauri event and dispatches to the store. Routing decides the surface: OS notification when the window is unfocused, toast when focused but the agent's tab is hidden, bell-only otherwise. Terminal-source only: no `local` agent, no managed review, no built-in AI.

**Tech Stack:** React 19, TypeScript, zustand, `@tauri-apps/api` (event, window), `@tauri-apps/plugin-notification`, sonner (toasts), shadcn/ui primitives, vitest for tests.

## Global Constraints

(From `docs/architecture/agent-awareness.md` and `PUHON.md`. Every task inherits these.)

- No em-dash anywhere. No emojis anywhere. Comments default to none; if needed, 1 to 2 lines on why.
- Frontend imports always `@/...`, never relative across modules.
- Frontend checks before claiming a task done: `pnpm lint`, `pnpm check-types`, `pnpm test`.
- No built-in AI. This module observes external CLIs only. Do not port Terax's `localAgent`, `setLocalAgent`, `LocalAgentState`, `LocalAgentNotificationsBridge`, `managedAgentsStore`, or `review.ts`. Do not create or import anything from `modules/ai`.
- Zero cost when idle: the bridge is one event listener; the store only updates on lifecycle transitions.
- `source` is always `"terminal"`. There is one agent source.

## File Structure

- **Create** `src/modules/agents/index.ts` - barrel.
- **Create** `src/modules/agents/lib/types.ts` - terminal-only types.
- **Create** `src/modules/agents/lib/format.ts`, `lib/useWindowFocus.ts`, `lib/agentIcon.tsx`, `lib/notify.ts`, `lib/route.ts`.
- **Create** `src/modules/agents/store/agentStore.ts` - zustand store (no localAgent).
- **Create** `src/modules/agents/components/AgentNotificationsBridge.tsx`, `components/NotificationBell.tsx`, `components/AgentToast.tsx`.
- **Modify** `src/modules/settings/preferences.ts` - add the `agentNotifications` preference (default true).
- **Modify** the Settings UI - add an "Agent notifications" toggle.
- **Modify** `src/app/App.tsx` - mount `<AgentNotificationsBridge />` and `<NotificationBell />`.
- **Modify** `src-tauri/capabilities/default.json` - allow the notification permission if not already present.

---

### Task 1: Module scaffold and terminal-only types

**Files:**

- Create: `src/modules/agents/lib/types.ts`
- Create: `src/modules/agents/index.ts`

**Interfaces:**

- Produces: `AgentStatus`, `AgentSignalKind`, `AgentSignal`, `AgentSession`, `AgentNotification`, `NotificationKind`. No `AgentSource` union and no `LocalAgentState`.

- [ ] **Step 1: Write the types**

`src/modules/agents/lib/types.ts`:

```ts
export type AgentStatus = "working" | "waiting";

export type AgentSignalKind =
  | "started"
  | "working"
  | "attention"
  | "finished"
  | "exited";

export type AgentSignal = {
  id: number;
  kind: AgentSignalKind;
  agent: string | null;
};

export type AgentSession = {
  leafId: number;
  tabId: number;
  agent: string;
  status: AgentStatus;
  startedAt: number;
  lastActivityAt: number;
  attentionSince: number | null;
};

export type NotificationKind = "attention" | "finished" | "error";

export type AgentNotification = {
  id: string;
  /** Always "terminal": Puhon only observes external CLIs. */
  source: "terminal";
  leafId: number;
  tabId: number;
  agent: string;
  kind: NotificationKind;
  at: number;
  read: boolean;
};
```

- [ ] **Step 2: Write the barrel (minimal; extend in later tasks)**

`src/modules/agents/index.ts`:

```ts
export type {
  AgentNotification,
  AgentSession,
  AgentSignal,
  AgentSignalKind,
  AgentStatus,
  NotificationKind,
} from "./lib/types";
```

- [ ] **Step 3: Verify it type-checks**

Run: `pnpm check-types`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/agents/index.ts src/modules/agents/lib/types.ts
git commit -m "feat(agents): scaffold frontend module and terminal-only types"
```

---

### Task 2: The agent store

**Files:**

- Create: `src/modules/agents/store/agentStore.ts`
- Test: `src/modules/agents/store/agentStore.test.ts`

**Interfaces:**

- Produces: `useAgentStore` (zustand) with `sessions`, `notifications`, and actions `start`, `setStatus`, `finish`, `pushNotification`, `markAllRead`, `clearNotifications`; plus `nextAttentionTarget()`.

- [ ] **Step 1: Write the failing test**

`src/modules/agents/store/agentStore.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore, nextAttentionTarget } from "./agentStore";

beforeEach(() => {
  useAgentStore.setState({ sessions: {}, notifications: [] });
});

describe("agentStore", () => {
  it("starts a session as working", () => {
    useAgentStore.getState().start(1, 10, "codex");
    const s = useAgentStore.getState().sessions[1];
    expect(s?.agent).toBe("codex");
    expect(s?.status).toBe("working");
    expect(s?.tabId).toBe(10);
  });

  it("flips status to waiting and records attentionSince", () => {
    useAgentStore.getState().start(1, 10, "codex");
    useAgentStore.getState().setStatus(1, "waiting");
    expect(useAgentStore.getState().sessions[1]?.status).toBe("waiting");
    expect(useAgentStore.getState().sessions[1]?.attentionSince).not.toBeNull();
  });

  it("is a no-op when the status is unchanged", () => {
    useAgentStore.getState().start(1, 10, "codex");
    const before = useAgentStore.getState().sessions[1];
    useAgentStore.getState().setStatus(1, "working");
    expect(useAgentStore.getState().sessions[1]).toBe(before);
  });

  it("removes the session on finish", () => {
    useAgentStore.getState().start(1, 10, "codex");
    useAgentStore.getState().finish(1);
    expect(useAgentStore.getState().sessions[1]).toBeUndefined();
  });

  it("caps notifications at 50 and marks new ones unread", () => {
    for (let i = 0; i < 60; i++) {
      useAgentStore.getState().pushNotification({
        source: "terminal",
        agent: "codex",
        kind: "finished",
        tabId: 1,
        leafId: i,
      });
    }
    expect(useAgentStore.getState().notifications.length).toBe(50);
    expect(useAgentStore.getState().notifications[0]?.read).toBe(false);
  });

  it("marks all read and clears", () => {
    useAgentStore.getState().pushNotification({
      source: "terminal",
      agent: "codex",
      kind: "attention",
      tabId: 1,
      leafId: 0,
    });
    useAgentStore.getState().markAllRead();
    expect(useAgentStore.getState().notifications[0]?.read).toBe(true);
    useAgentStore.getState().clearNotifications();
    expect(useAgentStore.getState().notifications.length).toBe(0);
  });

  it("nextAttentionTarget returns the most recently waiting session", () => {
    useAgentStore.getState().start(1, 10, "codex");
    useAgentStore.getState().start(2, 20, "pi");
    useAgentStore.getState().setStatus(1, "waiting");
    useAgentStore.getState().setStatus(2, "waiting");
    expect(nextAttentionTarget()?.leafId).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- agentStore`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the store**

`src/modules/agents/store/agentStore.ts`:

```ts
import { create } from "zustand";
import type {
  AgentNotification,
  AgentSession,
  AgentStatus,
} from "../lib/types";

const MAX_NOTIFICATIONS = 50;

let notifSeq = 0;

type AgentStoreState = {
  sessions: Record<number, AgentSession>;
  notifications: AgentNotification[];
  start: (leafId: number, tabId: number, agent: string) => void;
  setStatus: (leafId: number, status: AgentStatus) => void;
  finish: (leafId: number) => void;
  pushNotification: (
    n: Omit<AgentNotification, "id" | "at" | "read">,
  ) => void;
  markAllRead: () => void;
  clearNotifications: () => void;
};

export const useAgentStore = create<AgentStoreState>((set) => ({
  sessions: {},
  notifications: [],

  start: (leafId, tabId, agent) =>
    set((s) => {
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            leafId,
            tabId,
            agent,
            status: "working",
            startedAt: now,
            lastActivityAt: now,
            attentionSince: null,
          },
        },
      };
    }),

  setStatus: (leafId, status) =>
    set((s) => {
      const prev = s.sessions[leafId];
      if (!prev || prev.status === status) return s;
      const now = Date.now();
      return {
        sessions: {
          ...s.sessions,
          [leafId]: {
            ...prev,
            status,
            lastActivityAt: now,
            attentionSince: status === "waiting" ? now : null,
          },
        },
      };
    }),

  finish: (leafId) =>
    set((s) => {
      if (!s.sessions[leafId]) return s;
      const next = { ...s.sessions };
      delete next[leafId];
      return { sessions: next };
    }),

  pushNotification: (n) =>
    set((s) => ({
      notifications: [
        { ...n, id: `n${++notifSeq}`, at: Date.now(), read: false },
        ...s.notifications,
      ].slice(0, MAX_NOTIFICATIONS),
    })),

  markAllRead: () =>
    set((s) => {
      if (!s.notifications.some((n) => !n.read)) return s;
      return { notifications: s.notifications.map((n) => ({ ...n, read: true })) };
    }),

  clearNotifications: () => set({ notifications: [] }),
}));

/** The tab/leaf of the agent that most recently entered the waiting state, for
 *  the keyboard jump-to-attention shortcut. Null when none is waiting. */
export function nextAttentionTarget(): { tabId: number; leafId: number } | null {
  const waiting = Object.values(useAgentStore.getState().sessions)
    .filter((s) => s.status === "waiting")
    .sort((a, b) => (b.attentionSince ?? 0) - (a.attentionSince ?? 0));
  const t = waiting[0];
  return t ? { tabId: t.tabId, leafId: t.leafId } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- agentStore`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/store/agentStore.ts src/modules/agents/store/agentStore.test.ts
git commit -m "feat(agents): terminal-source agent session store"
```

---

### Task 3: Supporting libs - format, window focus, agent icon

**Files:**

- Create: `src/modules/agents/lib/format.ts`
- Create: `src/modules/agents/lib/useWindowFocus.ts`
- Create: `src/modules/agents/lib/agentIcon.tsx`

- [ ] **Step 1: format.ts**

`src/modules/agents/lib/format.ts`:

```ts
// Antigravity CLI (invoked as `agy`, with `gemini` as the legacy alias) and
// Antigravity proper all map to one label.
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
```

- [ ] **Step 2: useWindowFocus.ts**

`src/modules/agents/lib/useWindowFocus.ts`:

```ts
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return focused;
}
```

- [ ] **Step 3: agentIcon.tsx**

A colored badge with the agent's initial. Avoids guessing per-agent icon names; a maintainer can swap in hugeicons later.

`src/modules/agents/lib/agentIcon.tsx`:

```tsx
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
```

- [ ] **Step 4: Type-check and lint**

Run: `pnpm check-types && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/lib/format.ts src/modules/agents/lib/useWindowFocus.ts src/modules/agents/lib/agentIcon.tsx
git commit -m "feat(agents): display, window-focus, and icon helpers"
```

---

### Task 4: OS notifications

**Files:**

- Create: `src/modules/agents/lib/notify.ts`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: notify.ts**

`src/modules/agents/lib/notify.ts`:

```ts
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let granted = false;

async function ensurePermission(): Promise<boolean> {
  // Cache only the positive result: a transient denial (e.g. the OS prompt
  // dismissed while unfocused) must not disable notifications for the session.
  if (granted) return true;
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === "granted";
  granted = ok;
  return ok;
}

export async function osNotify(title: string, body: string): Promise<void> {
  try {
    if (await ensurePermission()) sendNotification({ title, body });
  } catch (e) {
    console.warn("[puhon] os notification failed:", e);
  }
}
```

- [ ] **Step 2: Allow the notification permission**

In `src-tauri/capabilities/default.json`, add the notification permission to the permissions array if it is not already present:

```json
"notifications:default",
"notifications:allow-notify",
"notifications:allow-request-permission",
"notifications:allow-is-permission-granted"
```

(Inspect the file first; if `core:default` already grants notification scope, this step is a no-op.)

- [ ] **Step 3: Build to confirm the capability parses**

Run: `pnpm tauri dev` is heavy for a check; instead confirm JSON validity:

Run: `node -e "JSON.parse(require('fs').readFileSync('src-tauri/capabilities/default.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add src/modules/agents/lib/notify.ts src-tauri/capabilities/default.json
git commit -m "feat(agents): OS notification helper and capability"
```

---

### Task 5: Notification routing

**Files:**

- Create: `src/modules/agents/lib/route.ts`
- Test: `src/modules/agents/lib/route.test.ts`

**Interfaces:**

- Produces: `routeAgentNotification(args)` deciding OS notify vs toast vs bell-only vs nothing, gated on the `agentNotifications` preference.

- [ ] **Step 1: Write the failing test**

`src/modules/agents/lib/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgentNotification } from "./route";
import { useAgentStore } from "../store/agentStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

vi.mock("./notify", () => ({ osNotify: vi.fn() }));
vi.mock("../components/AgentToast", () => ({ showAgentToast: vi.fn() }));

beforeEach(() => {
  useAgentStore.setState({ notifications: [] });
  usePreferencesStore.setState({ agentNotifications: true });
});

describe("routeAgentNotification", () => {
  it("does nothing when focused and visible", () => {
    routeAgentNotification({
      agent: "codex", kind: "attention", title: "t",
      focused: true, visible: true, allowToast: true, onActivate: () => {},
    });
    expect(useAgentStore.getState().notifications).toHaveLength(0);
  });

  it("OS-notifies when unfocused and pushes to the bell", () => {
    const { osNotify } = require("./notify") as { osNotify: ReturnType<typeof vi.fn> };
    osNotify.mockClear();
    routeAgentNotification({
      agent: "codex", kind: "finished", title: "t", body: "b",
      focused: false, visible: false, allowToast: false, onActivate: () => {},
    });
    expect(osNotify).toHaveBeenCalledWith("t", "b");
    expect(useAgentStore.getState().notifications).toHaveLength(1);
  });

  it("toasts when focused but hidden and allowToast", () => {
    const { showAgentToast } = require("../components/AgentToast") as {
      showAgentToast: ReturnType<typeof vi.fn>;
    };
    showAgentToast.mockClear();
    routeAgentNotification({
      agent: "codex", kind: "attention", title: "t",
      focused: true, visible: false, allowToast: true, onActivate: () => {},
    });
    expect(showAgentToast).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().notifications).toHaveLength(1);
  });

  it("respects the agentNotifications preference being off", () => {
    usePreferencesStore.setState({ agentNotifications: false });
    routeAgentNotification({
      agent: "codex", kind: "finished", title: "t",
      focused: false, visible: false, allowToast: false, onActivate: () => {},
    });
    expect(useAgentStore.getState().notifications).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- route`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement routing**

`src/modules/agents/lib/route.ts`:

```ts
import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "../components/AgentToast";
import { useAgentStore } from "../store/agentStore";
import { osNotify } from "./notify";
import type { NotificationKind } from "./types";

type RouteArgs = {
  agent: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  focused: boolean;
  /** True when the user is currently looking at this agent. */
  visible: boolean;
  /** Allow an in-app toast when focused but not looking at the agent. */
  allowToast: boolean;
  tabId?: number;
  leafId?: number;
  onActivate: () => void;
};

export function routeAgentNotification({
  agent,
  kind,
  title,
  body,
  focused,
  visible,
  allowToast,
  tabId = 0,
  leafId = 0,
  onActivate,
}: RouteArgs): void {
  if (!usePreferencesStore.getState().agentNotifications) return;
  if (focused && visible) return;

  useAgentStore.getState().pushNotification({
    source: "terminal",
    agent,
    kind,
    tabId,
    leafId,
  });

  if (!focused) {
    void osNotify(title, body ?? agent);
    return;
  }
  if (allowToast) {
    showAgentToast({ agent, title, body, onActivate });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- route`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/lib/route.ts src/modules/agents/lib/route.test.ts
git commit -m "feat(agents): route notifications by focus and visibility"
```

---

### Task 6: Toast

**Files:**

- Create: `src/modules/agents/components/AgentToast.tsx`

- [ ] **Step 1: Implement the toast**

`src/modules/agents/components/AgentToast.tsx`:

```tsx
import { toast } from "sonner";
import { AgentIcon } from "../lib/agentIcon";

type AgentToastArgs = {
  agent: string;
  title: string;
  body?: string;
  onActivate: () => void;
};

export function showAgentToast({ agent, title, body, onActivate }: AgentToastArgs) {
  toast(title, {
    description: body,
    icon: <AgentIcon agent={agent} size={18} />,
    action: { label: "Open", onClick: onActivate },
    duration: 6000,
  });
}
```

Note: Terax's toast adds a keyboard hint via `shortcutLabel("agent.focusAttention")`. That shortcut is not registered in Puhon yet. Keep the toast minimal now; a Phase 2 task can register the shortcut and re-add the hint.

- [ ] **Step 2: Type-check and lint**

Run: `pnpm check-types && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/agents/components/AgentToast.tsx
git commit -m "feat(agents): agent attention toast"
```

---

### Task 7: The signal bridge

**Files:**

- Create: `src/modules/agents/components/AgentNotificationsBridge.tsx`

**Interfaces:**

- Produces: `AgentNotificationsBridge` (renders null) that listens for `puhon:agent-signal`, resolves PTY id to leaf id, and dispatches to the store. No managed-review call.

- [ ] **Step 1: Implement the bridge**

`src/modules/agents/components/AgentNotificationsBridge.tsx`:

```tsx
import type { Tab } from "@/modules/tabs";
import { hasLeaf, leafIdForPty } from "@/modules/terminal";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";
import { displayAgent } from "../lib/format";
import { routeAgentNotification } from "../lib/route";
import type { AgentSession, AgentSignal } from "../lib/types";
import { useWindowFocus } from "../lib/useWindowFocus";
import { useAgentStore } from "../store/agentStore";

type Activate = (tabId: number, leafId: number) => void;
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
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
    // finished fires every turn, so it only updates the bell; attention toasts.
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
    case "exited":
      store.finish(leafId);
      return;
  }
}

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
}: {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
}) {
  const focused = useWindowFocus();
  const ctxRef = useRef<Ctx>({ tabs, activeId, focused, onActivate });
  ctxRef.current = { tabs, activeId, focused, onActivate };

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    listen<AgentSignal>("puhon:agent-signal", (e) =>
      handleSignal(e.payload, ctxRef.current),
    )
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return null;
}
```

- [ ] **Step 2: Confirm the terminal barrel exports `hasLeaf` and `leafIdForPty`**

Run: `rg -n "hasLeaf|leafIdForPty" src/modules/terminal/index.ts`
Expected: both are exported. If not, add them to the barrel (they exist in the terminal module from the shared lineage).

- [ ] **Step 3: Type-check and lint**

Run: `pnpm check-types && pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/agents/components/AgentNotificationsBridge.tsx
git commit -m "feat(agents): bridge agent signals to the store and routing"
```

---

### Task 8: The notification bell

**Files:**

- Create: `src/modules/agents/components/NotificationBell.tsx`

Terminal-source only: no `onActivateLocal`, no `localAgent`, no `source === "local"` branch. Lists the five agents in the install section.

- [ ] **Step 1: Implement the bell**

`src/modules/agents/components/NotificationBell.tsx`:

```tsx
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  Notification01Icon,
  Notification03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { AgentIcon } from "../lib/agentIcon";
import { displayAgent } from "../lib/format";
import type { AgentNotification, AgentStatus } from "../lib/types";
import { useAgentStore } from "../store/agentStore";

type Props = {
  onActivate: (tabId: number, leafId: number) => void;
};

const HOOK_AGENTS = ["claude", "codex", "pi", "opencode", "antigravity"] as const;

const NOTIF_LABEL: Record<AgentNotification["kind"], string> = {
  attention: "needs input",
  finished: "finished",
  error: "failed",
};

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusRow({
  agent,
  status,
  onClick,
}: {
  agent: string;
  status: AgentStatus;
  onClick: () => void;
}) {
  const waiting = status === "waiting";
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <AgentIcon agent={agent} size={16} />
      <span className="flex-1 truncate text-sm text-foreground">
        {displayAgent(agent)}
      </span>
      <span
        className={cn(
          "flex items-center gap-1.5 text-xs",
          waiting ? "font-medium text-primary" : "text-muted-foreground",
        )}
      >
        {waiting ? <span className="size-1.5 rounded-full bg-primary" /> : null}
        {waiting ? "waiting" : "working"}
      </span>
    </button>
  );
}

function HookAgentRow({
  id,
  ready,
  installing,
  onEnable,
}: {
  id: string;
  ready: boolean;
  installing: boolean;
  onEnable: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <AgentIcon agent={id} size={14} />
      <span className="flex-1 truncate text-[12px] text-muted-foreground">
        {displayAgent(id)}
      </span>
      {ready ? (
        <span className="flex items-center gap-1 text-[11px] font-medium text-primary">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={13} strokeWidth={1.75} />
          enabled
        </span>
      ) : (
        <button
          type="button"
          onClick={onEnable}
          disabled={installing}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          {installing ? (
            <HugeiconsIcon icon={Loading03Icon} size={12} strokeWidth={1.75} className="animate-spin" />
          ) : null}
          {installing ? "Enabling" : "Enable"}
        </button>
      )}
    </div>
  );
}

function NotificationRow({ n, onClick }: { n: AgentNotification; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent"
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {n.kind === "finished" ? (
          <HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} strokeWidth={1.75} className="text-muted-foreground" />
        ) : (
          <span className={cn("size-1.5 rounded-full", n.kind === "error" ? "bg-destructive" : "bg-primary")} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
        {displayAgent(n.agent)}{" "}
        <span className="text-muted-foreground">{NOTIF_LABEL[n.kind]}</span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
        {relativeTime(n.at)}
      </span>
    </button>
  );
}

export function NotificationBell({ onActivate }: Props) {
  const [open, setOpen] = useState(false);
  const [hooks, setHooks] = useState<Record<string, boolean>>({});
  const [installing, setInstalling] = useState<string | null>(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const sessions = useAgentStore((s) => s.sessions);
  const notifications = useAgentStore((s) => s.notifications);
  const markAllRead = useAgentStore((s) => s.markAllRead);
  const clearNotifications = useAgentStore((s) => s.clearNotifications);

  const active = useMemo(() => Object.values(sessions), [sessions]);
  const waitingCount = active.filter((s) => s.status === "waiting").length;
  const unreadDone = notifications.filter((n) => !n.read && n.kind !== "attention").length;
  const badge = waitingCount + unreadDone;
  const enabledCount = HOOK_AGENTS.filter((id) => hooks[id] === true).length;

  const refreshHooks = () => {
    for (const id of HOOK_AGENTS) {
      invoke<boolean>("agent_hooks_status", { agent: id })
        .then((ok) => setHooks((h) => ({ ...h, [id]: ok })))
        .catch(() => setHooks((h) => ({ ...h, [id]: false })));
    }
  };

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      markAllRead();
      refreshHooks();
    }
  };

  const enableHooks = async (id: string) => {
    setInstalling(id);
    try {
      await invoke("agent_enable_hooks", { agent: id });
      setHooks((h) => ({ ...h, [id]: true }));
    } catch {
      setHooks((h) => ({ ...h, [id]: false }));
    } finally {
      setInstalling(null);
    }
  };

  const activate = (tabId: number, leafId: number) => {
    onActivate(tabId, leafId);
    setOpen(false);
  };

  const empty = active.length === 0 && notifications.length === 0;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Agent notifications"
        >
          <HugeiconsIcon icon={Notification01Icon} size={16} strokeWidth={1.75} />
          {badge > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold leading-none text-primary-foreground">
              {badge > 9 ? "9+" : badge}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-80 gap-0.5 overflow-hidden p-0">
        <div className="flex h-10 items-center gap-2 px-3 pt-0.5">
          <span className="flex gap-1 text-[13px] text-foreground">Notifications</span>
          <div className="ml-auto flex items-center gap-2">
            {active.length > 0 ? (
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {active.length} active
              </span>
            ) : null}
            {notifications.length > 0 ? (
              <button
                type="button"
                onClick={clearNotifications}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>

        {empty ? (
          <div className="border-t border-border/60 px-3 py-5 text-center text-xs leading-relaxed text-muted-foreground">
            No agent activity yet.
            <br />
            Run a coding agent (Claude Code, Codex, Pi, OpenCode, Antigravity) to track it here.
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto border-t border-border/60 p-1">
            {active.map((s) => (
              <StatusRow
                key={s.leafId}
                agent={s.agent}
                status={s.status}
                onClick={() => activate(s.tabId, s.leafId)}
              />
            ))}
            {active.length > 0 && notifications.length > 0 ? (
              <div className="mx-2 my-1 h-px bg-border/50" />
            ) : null}
            {notifications.map((n) => (
              <NotificationRow key={n.id} n={n} onClick={() => activate(n.tabId, n.leafId)} />
            ))}
          </div>
        )}

        <div className="border-t border-border/60 p-1">
          <button
            type="button"
            onClick={() => setAlertsOpen((v) => !v)}
            aria-expanded={alertsOpen}
            className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <HugeiconsIcon icon={Notification03Icon} size={11} strokeWidth={2} />
            Agent alerts
            <span className="ml-auto flex items-center gap-1.5 normal-case tracking-normal">
              {enabledCount > 0 ? (
                <span className="text-[10px] text-muted-foreground/60">{enabledCount} on</span>
              ) : null}
              <HugeiconsIcon icon={alertsOpen ? ArrowUp01Icon : ArrowDown01Icon} size={13} strokeWidth={2} />
            </span>
          </button>
          {alertsOpen
            ? HOOK_AGENTS.map((id) => (
                <HookAgentRow
                  key={id}
                  id={id}
                  ready={hooks[id] === true}
                  installing={installing === id}
                  onEnable={() => enableHooks(id)}
                />
              ))
            : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Type-check and lint**

Run: `pnpm check-types && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/modules/agents/components/NotificationBell.tsx
git commit -m "feat(agents): terminal-source notification bell with install controls"
```

---

### Task 9: Settings preference and toggle

**Files:**

- Modify: `src/modules/settings/preferences.ts`
- Modify: the Settings UI section that renders toggles.

- [ ] **Step 1: Add the preference**

In `src/modules/settings/preferences.ts`, add to the `State` interface (next to the other booleans such as `restoreTerminalScrollback`):

```ts
  agentNotifications: boolean;
```

In the `create(...)` initializer, add the default:

```ts
  agentNotifications: true,
```

Follow the same persistence pattern the other preferences use (the store's save/load hooks pick up new keys automatically in this codebase).

- [ ] **Step 2: Add the toggle to the Settings UI**

Find the Settings section that renders the other boolean toggles (search for an existing toggle such as `restoreTerminalScrollback` or `explorerGitDecorations`). Add a matching toggle row:

```tsx
<ToggleRow
  prefKey="agentNotifications"
  label="Agent notifications"
  description="Bell and OS notifications when an agent needs input or finishes in a hidden tab."
/>
```

Use the exact toggle component and props the neighboring rows use. If the section uses a different helper name, mirror it.

- [ ] **Step 3: Type-check, lint, test**

Run: `pnpm check-types && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/settings/preferences.ts <settings ui file>
git commit -m "feat(agents): agent notifications preference (default on)"
```

---

### Task 10: Mount the bridge and bell, finalize barrel

**Files:**

- Modify: `src/app/App.tsx`
- Modify: `src/modules/agents/index.ts`

- [ ] **Step 1: Extend the barrel**

`src/modules/agents/index.ts`:

```ts
export { AgentNotificationsBridge } from "./components/AgentNotificationsBridge";
export { NotificationBell } from "./components/NotificationBell";
export { nextAttentionTarget } from "./store/agentStore";
export type {
  AgentNotification,
  AgentSession,
  AgentSignal,
  AgentSignalKind,
  AgentStatus,
  NotificationKind,
} from "./lib/types";
```

- [ ] **Step 2: Mount in App.tsx**

In `src/app/App.tsx`, import alongside the other module imports:

```ts
import { AgentNotificationsBridge, NotificationBell } from "@/modules/agents";
```

Render the bridge once (it returns null) near the top of the app tree, passing the current tabs, active id, and an activate handler that switches to a tab and focuses a leaf (reuse the existing tab-activation logic; if a `focusLeaf(tabId, leafId)` helper exists, call it):

```tsx
<AgentNotificationsBridge
  tabs={tabs}
  activeId={activeTabId}
  onActivate={(tabId, leafId) => {
    setActiveTabId(tabId);
    // focus the leaf within the tab if a focus helper exists
  }}
/>
```

Render the bell inside the header area (next to where `<Header ...>` is rendered at approximately line 975), passing the same activate handler:

```tsx
<NotificationBell
  onActivate={(tabId, leafId) => {
    setActiveTabId(tabId);
    // focus the leaf within the tab if a focus helper exists
  }}
/>
```

If the bell must live inside the `Header` component rather than beside it in `App.tsx`, pass `onActivate` down through `Header`'s props and render `<NotificationBell />` there. Match the existing header layout convention.

- [ ] **Step 3: Full frontend gate**

Run: `pnpm lint && pnpm check-types && pnpm test`
Expected: PASS.

- [ ] **Step 4: Manual end-to-end smoke**

Run: `pnpm tauri dev`. With Plan 1 and Plan 2 in place:

1. Open the bell, expand "Agent alerts", click "Enable" for an installed agent (e.g. Claude Code or Pi). Confirm `agent_hooks_status` flips to enabled.
2. Run that agent in a terminal tab; switch to another tab so the agent tab is hidden.
3. Trigger an attention or finished event. Confirm: the bell badge increments, a toast or OS notification appears, and clicking the bell row activates the agent's tab.
4. Toggle "Agent notifications" off in Settings; repeat; confirm no bell, toast, or OS notification fires (detection still runs, just no UI).
5. Run a non-agent command (`ls`); confirm no false session.

- [ ] **Step 5: Commit**

```bash
git add src/modules/agents/index.ts src/app/App.tsx
git commit -m "feat(agents): mount bridge and bell in the app"
```

---

## Self-review

**Spec coverage** (against `docs/architecture/agent-awareness.md`):

- Section 9 frontend (types, store, bridge, notify, route, bell, toast, settings pref): Tasks 1 to 10.
- Section 10 boundary (no `local`/`localAgent`/managed review/AI): enforced throughout. `AgentNotificationsBridge` has no `maybeTriggerManagedReview` call; the store has no `localAgent`; the bell has no `onActivateLocal`.
- Section 13 frontend tests (store, routing matrix): Tasks 2 and 5.
- Detector (Plan 1) and install backend (Plan 2) are out of scope here.

**Placeholder scan:** none. Every code step has full code and exact paths. The two integration touches that depend on existing Puhon structure - the Settings toggle component name and the App.tsx tab-focus helper - are described by reference to a neighboring existing toggle and the existing activation logic, with an explicit "mirror the existing pattern" instruction rather than invented APIs.

**Type consistency:** `AgentSignal`, `AgentSession`, `AgentNotification`, `useAgentStore`, `nextAttentionTarget`, `routeAgentNotification`, `osNotify`, `showAgentToast`, `displayAgent`, `useWindowFocus`, `AgentIcon` are defined once and consumed consistently. The `source` field is the literal `"terminal"` everywhere it appears.

**Risks carried into execution:**

- `hasLeaf`/`leafIdForPty` exports (Task 7): verified by a grep step; the shared lineage has them.
- Settings toggle component name (Task 9): resolved by mirroring a neighbor; the grep/find step locates it.
- App.tsx leaf-focus helper (Task 10): described by reference; if none exists, tab activation alone is acceptable for v1 (the bell row still switches tabs).
- The OpenCode and Antigravity event wiring can only be fully confirmed live; the Task 10 smoke covers all five agents that are installed.

## Closing

With Plan 1 (detector + PTY wiring), Plan 2 (install backend + adapters), and Plan 3 (this frontend) all landed, the agent-awareness layer is complete for v1: detection of all five agents, OS + bell + toast notifications gated on focus and visibility, per-agent install controls, and a default-on Settings toggle, with zero built-in AI.
