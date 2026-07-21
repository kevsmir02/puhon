# Web Preview Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect localhost URLs from PTY output in Rust and attribute them to the terminal tab that produced them, so clicking a preview pill opens the right preview surface.

**Architecture:** A `UrlDetector` struct sits alongside `AgentDetector` in the PTY reader thread, scanning output for localhost URLs. It emits a `puhon:preview-url` Tauri event with the PTY id. The frontend bridge maps pty_id→leafId→tabId, sets `previewUrl` on the `TerminalTab`, and a `PreviewUrlPill` in the Header + a globe badge on the tab bar make it visible and clickable.

**Tech Stack:** Rust (regex crate: `grep-regex` already in tree), TypeScript, React, Tauri events

## Global Constraints

- No new dependencies — `grep-regex` already in Cargo.toml
- `previewUrl` is transient (never persisted to disk)
- Rate limit: max 1 URL emission per PTY session per 500ms
- Only localhost/127.0.0.1/0.0.0.0/[::1] URLs are detected
- Preview tab opens in the source tab's space, dedup by URL within space

---

## File Structure

| File | Purpose |
| ------ | --------- |
| `src-tauri/src/modules/pty/url_detect.rs` | **New.** UrlDetector — regex scanner |
| `src-tauri/src/modules/pty/session.rs` | Wire UrlDetector into reader thread |
| `src/modules/tabs/lib/useTabs.ts` | Add `previewUrl?` to `TerminalTab`, add `openPreviewInSpace` |
| `src/modules/agents/components/AgentNotificationsBridge.tsx` | Listen for `puhon:preview-url`, update tabs |
| `src/modules/tabs/TabBar.tsx` | Globe badge in `TabIcon`, pass `onPreviewFromTab` prop |
| `src/modules/preview/PreviewUrlPill.tsx` | **New.** Header pill + dropdown |
| `src/modules/preview/index.ts` | Export `PreviewUrlPill` |
| `src/modules/header/Header.tsx` | Render `PreviewUrlPill`, pass props |
| `src/app/App.tsx` | Wire `openPreviewInSpace`, pass callbacks through Header |

---

### Task 1: UrlDetector — Rust scanner

**Files:**

- Create: `src-tauri/src/modules/pty/url_detect.rs`

**Interfaces:**

- Produces: `UrlDetector::new()`, `UrlDetector::process(input: &[u8], emit: impl FnMut(String))`, `PreviewUrlEvent { pty_id: u32, url: String }` (for Tauri event)

- [ ] **Step 1: Write UrlDetector module with tests**

```rust
// src-tauri/src/modules/pty/url_detect.rs

use grep_regex::RegexMatcher;
use regex::bytes::Regex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Emitted to the frontend when a localhost URL is detected in PTY output.
#[derive(Clone, serde::Serialize)]
pub struct PreviewUrlEvent {
    pub pty_id: u32,
    pub url: String,
}

/// Scans PTY output for localhost URLs and emits deduplicated, rate-limited events.
pub struct UrlDetector {
    matcher: RegexMatcher,
    last_url: HashMap<u32, (String, Instant)>,
    /// Scratch buffer for ANSI-stripped text
    clean: Vec<u8>,
}

impl UrlDetector {
    pub fn new() -> Self {
        let re = Regex::new(
            r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(/\S*)?"
        ).expect("url_detect regex compile");
        Self {
            matcher: RegexMatcher::new(re),
            last_url: HashMap::new(),
            clean: Vec::with_capacity(8192),
        }
    }

    /// Process a chunk of PTY output. Strips ANSI escape sequences, then
    /// scans for localhost URLs. Emits via `emit` when a new URL is found
    /// and the per-session rate limit has elapsed.
    pub fn process<F: FnMut(String)>(&mut self, input: &[u8], pty_id: u32, mut emit: F) {
        // Strip ANSI escape sequences
        self.clean.clear();
        strip_ansi_escapes(input, &mut self.clean);

        let entry = self.last_url.entry(pty_id).or_insert_with(|| {
            (String::new(), Instant::now() - Duration::from_secs(1))
        });
        let (ref mut last, ref mut last_emit) = *entry;

        for m in self.matcher.find_iter(&self.clean) {
            let url = std::str::from_utf8(m.as_bytes())
                .unwrap_or("");
            if url.is_empty() || url == *last {
                continue;
            }
            // Rate limit: at most one emission per 500ms per session
            let now = Instant::now();
            if now.duration_since(*last_emit) < Duration::from_millis(500) {
                continue;
            }
            *last = url.to_string();
            *last_emit = now;
            emit(url.to_string());
        }
    }

    /// Forget all tracked state for a PTY session.
    pub fn clear(&mut self, pty_id: u32) {
        self.last_url.remove(&pty_id);
    }
}

/// Strip ANSI escape sequences in-place, writing clean bytes to `out`.
fn strip_ansi_escapes(input: &[u8], out: &mut Vec<u8>) {
    let mut i = 0;
    let len = input.len();
    while i < len {
        if input[i] == 0x1b && i + 1 < len && input[i + 1] == b'[' {
            // Skip CSI until final byte (0x40-0x7e)
            i += 2;
            while i < len && !(0x40..=0x7e).contains(&input[i]) {
                i += 1;
            }
            if i < len {
                i += 1; // skip final byte
            }
        } else if input[i] == 0x1b && i + 1 < len && input[i + 1] == b']' {
            // Skip OSC until ST (ESC \) or BEL
            i += 2;
            while i < len {
                if input[i] == 0x1b && i + 1 < len && input[i + 1] == b'\\' {
                    i += 2;
                    break;
                }
                if input[i] == 0x07 {
                    i += 1;
                    break;
                }
                i += 1;
            }
        } else {
            out.push(input[i]);
            i += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(input: &[u8]) -> Vec<String> {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        // Use a fresh pty_id per test to avoid rate-limit interference
        d.process(input, 1, |url| out.push(url));
        out
    }

    #[test]
    fn basic_localhost() {
        let urls = detect(b"Starting dev server on http://localhost:3000");
        assert_eq!(urls, vec!["http://localhost:3000"]);
    }

    #[test]
    fn https_localhost() {
        let urls = detect(b"Ready: https://localhost:8443/api");
        assert_eq!(urls, vec!["https://localhost:8443/api"]);
    }

    #[test]
    fn ipv4_loopback() {
        let urls = detect(b"http://127.0.0.1:5173/");
        assert_eq!(urls, vec!["http://127.0.0.1:5173/"]);
    }

    #[test]
    fn ipv6_loopback() {
        let urls = detect(b"http://[::1]:3000");
        assert_eq!(urls, vec!["http://[::1]:3000"]);
    }

    #[test]
    fn no_port() {
        let urls = detect(b"http://localhost/hello");
        assert_eq!(urls, vec!["http://localhost/hello"]);
    }

    #[test]
    fn zero_ip() {
        let urls = detect(b"http://0.0.0.0:8080");
        assert_eq!(urls, vec!["http://0.0.0.0:8080"]);
    }

    #[test]
    fn non_localhost_ignored() {
        let urls = detect(b"http://example.com:3000 https://myapp.vercel.app");
        assert!(urls.is_empty());
    }

    #[test]
    fn ansi_interleaved_url() {
        // "Local: \x1b[1mhttp://localhost:3000\x1b[0m"
        let input = b"Local: \x1b[1mhttp://localhost:3000\x1b[0m";
        let urls = detect(input);
        assert_eq!(urls, vec!["http://localhost:3000"]);
    }

    #[test]
    fn dedup_same_url() {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        let input = b"http://localhost:3000";
        d.process(input, 1, |u| out.push(u));
        assert_eq!(out.len(), 1);
        let mut out2 = Vec::new();
        d.process(input, 1, |u| out2.push(u));
        assert!(out2.is_empty(), "duplicate should be suppressed");
    }

    #[test]
    fn different_url_emits() {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        d.process(b"http://localhost:3000", 1, |u| out.push(u));
        assert_eq!(out.len(), 1);
        // Advance time by hacking the stored Instant (we can't in unit tests,
        // but a new URL with a different session id skips rate limit)
        let mut out2 = Vec::new();
        d.process(b"http://localhost:5173", 2, |u| out2.push(u));
        assert_eq!(out2, vec!["http://localhost:5173"]);
    }

    #[test]
    fn url_with_path_and_query() {
        let urls = detect(b"http://localhost:3000/api/users?id=1");
        assert_eq!(urls, vec!["http://localhost:3000/api/users?id=1"]);
    }

    #[test]
    fn clear_forgets_state() {
        let mut d = UrlDetector::new();
        let mut out = Vec::new();
        d.process(b"http://localhost:3000", 1, |u| out.push(u));
        assert_eq!(out.len(), 1);
        d.clear(1);
        let mut out2 = Vec::new();
        d.process(b"http://localhost:3000", 1, |u| out2.push(u));
        assert_eq!(out2, vec!["http://localhost:3000"]);
    }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test --lib url_detect -- --nocapture`
Expected: all 11 tests pass

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/modules/pty/url_detect.rs
git commit -m "feat: add UrlDetector for localhost URL scanning in PTY output"
```

---

### Task 2: Wire UrlDetector into PTY reader thread

**Files:**

- Modify: `src-tauri/src/modules/pty/session.rs:232-267` (reader thread loop)

**Interfaces:**

- Consumes: `UrlDetector::new()`, `UrlDetector::process()`, `PreviewUrlEvent` from Task 1
- Produces: emits `puhon:preview-url` Tauri event

- [ ] **Step 1: Add the import and wire into the reader thread**

In `src-tauri/src/modules/pty/session.rs`, add at top with other imports:

```rust
use super::url_detect::{PreviewUrlEvent, UrlDetector};
```

In the reader thread spawn block (after `let mut agent_detect = AgentDetector::new();`):

```rust
let mut url_detect = UrlDetector::new();
```

Then after the `agent_detect.process` block and before `filtered.clear()`:

```rust
url_detect.process(&buf[..n], id, |url| {
    let _ = app_reader.emit("puhon:preview-url", PreviewUrlEvent { pty_id: id, url });
});
```

The full modified reader thread looks like:

```rust
let reader_thread = thread::Builder::new()
    .name("puhon-pty-reader".into())
    .spawn(move || {
        let mut buf = [0u8; READ_BUF];
        let mut filtered: Vec<u8> = Vec::with_capacity(READ_BUF);
        let mut da_filter = DaFilter::new();
        let mut agent_detect = AgentDetector::new();
        let mut url_detect = UrlDetector::new();
        let mut dropped_bytes: u64 = 0;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if !first_byte_r.load(Ordering::Relaxed) {
                        first_byte_r.store(true, Ordering::Release);
                        log::debug!("pty first byte after {}ms", spawn_at.elapsed().as_millis());
                    }
                    agent_detect.process(&buf[..n], |t| {
                        let _ = app_reader.emit(AGENT_EVENT, t.into_signal(id));
                    });
                    url_detect.process(&buf[..n], id, |url| {
                        let _ = app_reader.emit("puhon:preview-url", PreviewUrlEvent { pty_id: id, url });
                    });
                    filtered.clear();
                    // ... rest unchanged
```

- [ ] **Step 2: Build to verify compilation**

Run: `cargo build`
Expected: clean build, no errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/modules/pty/session.rs
git commit -m "feat: wire UrlDetector into PTY reader thread"
```

---

### Task 3: TypeScript types + openPreviewInSpace

**Files:**

- Modify: `src/modules/tabs/lib/useTabs.ts:32-46` (TerminalTab), around line 569 (newPreviewTab), and return object

**Interfaces:**

- Consumes: existing `TabBase`, `PreviewTab`
- Produces: `TerminalTab.previewUrl?: string`, `openPreviewInSpace(url: string, spaceId: string): number`

- [ ] **Step 1: Add previewUrl to TerminalTab**

In `src/modules/tabs/lib/useTabs.ts`, add to the `TerminalTab` type (after the `restoredState` line):

```typescript
export type TerminalTab = TabBase & {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  blocks?: boolean;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
  /** User-set label that overrides the cwd-derived name. Survives cd. */
  customTitle?: string;
  /** Serialized xterm scrollback restored from disk on boot. */
  restoredState?: string;
  /** Latest localhost URL detected in this tab's PTY output. Transient — never persisted. */
  previewUrl?: string;
};
```

- [ ] **Step 2: Add useSpaces import**

At the top of `useTabs.ts`, add the import (no circular dependency — `useSpaces.ts` does not import from `useTabs`):

```typescript
import { useSpaces } from "@/modules/spaces";
```

- [ ] **Step 3: Add openPreviewInSpace function**

After the `newPreviewTab` function (~line 582), add:

```typescript
const openPreviewInSpace = useCallback((url: string, spaceId: string) => {
  let targetId: number | null = null;
  setTabs((curr) => {
    // Dedup: if a preview tab for this URL already exists in this space, focus it.
    const existing = curr.find(
      (t) => t.kind === "preview" && t.url === url && t.spaceId === spaceId,
    );
    if (existing) {
      targetId = existing.id;
      return curr;
    }
    const id = nextIdRef.current++;
    targetId = id;
    return [...curr, { id, kind: "preview", spaceId, title: titleFromUrl(url), url }];
  });
  if (targetId !== null) {
    setActiveId(targetId);
    useSpaces.getState().setActive(spaceId);
  }
  return targetId!;
}, []);
```

- [ ] **Step 4: Add openPreviewInSpace to the hook's return object**

In the return object at the bottom of `useTabs`, add:

```typescript
    openPreviewInSpace,
```

- [ ] **Step 5: Build frontend to verify types**

Run: `npm run build`
Expected: no type errors

- [ ] **Step 6: Commit**

```bash
git add src/modules/tabs/lib/useTabs.ts
git commit -m "feat: add previewUrl to TerminalTab and openPreviewInSpace"
```

---

### Task 4: Frontend bridge — listen for puhon:preview-url

**Files:**

- Modify: `src/modules/agents/components/AgentNotificationsBridge.tsx`

**Interfaces:**

- Consumes: `leafIdForPty` from terminal, `useAgentStore`, `PreviewUrlEvent { pty_id: number, url: string }`, `Tab`, update functions
- Produces: updates `tab.previewUrl`, clears on agent exit

The `AgentNotificationsBridge` currently receives `{ tabs, activeId, onActivate }`. It needs access to `updateTab` to set `previewUrl`. Pass it as an additional prop.

- [ ] **Step 1: Add updateTab prop and preview-url listener**

Change the `AgentNotificationsBridge` signature:

```typescript
import type { PreviewUrlEvent } from "../../../src-tauri/src/modules/pty/url_detect";
```

Actually, since we can't import from Rust, define the type locally:

```typescript
type PreviewUrlEvent = { pty_id: number; url: string };
```

Modify the component:

```typescript
type Activate = (tabId: number, leafId: number) => void;
type UpdateTab = (id: number, patch: Partial<Tab>) => void;

type Props = {
  tabs: Tab[];
  activeId: number;
  onActivate: Activate;
  updateTab: UpdateTab;
};

export function AgentNotificationsBridge({
  tabs,
  activeId,
  onActivate,
  updateTab,
}: Props) {
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
      .then((u) => { if (alive) unlistenSignal = u; else u(); })
      .catch(() => {});

    listen<PreviewUrlEvent>("puhon:preview-url", (e) => {
      const leafId = leafIdForPty(e.payload.pty_id);
      if (leafId === null) return;
      const info = tabInfo(ctxRef.current.tabs, leafId);
      if (!info) return;
      ctxRef.current.updateTab(info.tabId, { previewUrl: e.payload.url } as Partial<Tab>);
    })
      .then((u) => { if (alive) unlistenUrl = u; else u(); })
      .catch(() => {});

    return () => {
      alive = false;
      unlistenSignal?.();
      unlistenUrl?.();
    };
  }, []);

  return null;
}
```

Also update the `Ctx` type and `handleSignal` to clear `previewUrl` on exit:

```typescript
type Ctx = {
  tabs: Tab[];
  activeId: number;
  focused: boolean;
  onActivate: Activate;
  updateTab: UpdateTab;
};
```

In `handleSignal`, in the `"exited"` case:

```typescript
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
```

- [ ] **Step 2: Update App.tsx to pass updateTab**

In `src/app/App.tsx`, where `AgentNotificationsBridge` is rendered:

```tsx
<AgentNotificationsBridge
  tabs={tabs}
  activeId={activeId}
  onActivate={handleActivateAgentLeaf}
  updateTab={updateTab}
/>
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: no type errors

- [ ] **Step 4: Commit**

```bash
git add src/modules/agents/components/AgentNotificationsBridge.tsx src/app/App.tsx
git commit -m "feat: listen for puhon:preview-url in AgentNotificationsBridge"
```

---

### Task 5: TabIcon globe badge

**Files:**

- Modify: `src/modules/tabs/TabBar.tsx` — `TabIcon` function and `Props`

**Interfaces:**

- Consumes: `Tab` (with `previewUrl?`), new `onPreviewFromTab` prop
- Produces: globe icon + green dot on tabs with `previewUrl`

- [ ] **Step 1: Add onPreviewFromTab prop to TabBar**

In the `Props` interface of `TabBar`, add:

```typescript
  /** Open a preview tab from a terminal tab's detected URL. */
  onPreviewFromTab?: (tabId: number, url: string, spaceId: string) => void;
```

Pass it through to `TabIcon` by adding it to the `TabIcon` signature:

```typescript
export function TabIcon({
  tab,
  onPreviewFromTab,
}: {
  tab: Tab;
  onPreviewFromTab?: (tabId: number, url: string, spaceId: string) => void;
}) {
```

- [ ] **Step 2: Add globe badge rendering in TabIcon**

After the `if (tab.kind === "preview")` block and before the terminal/incognito blocks, add:

```typescript
  if (tab.kind === "terminal" && tab.previewUrl) {
    return (
      <span
        role="button"
        tabIndex={-1}
        data-no-drag
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onPreviewFromTab?.(tab.id, tab.previewUrl!, tab.spaceId);
        }}
        title={`Preview ${tab.previewUrl}`}
        className="inline-flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm p-0.5 -m-0.5 transition-all hover:bg-accent"
      >
        <HugeiconsIcon
          icon={Globe02Icon}
          size={14}
          strokeWidth={2}
          className="shrink-0 text-green-500"
        />
        <span className="size-1.5 shrink-0 rounded-full bg-green-500" />
      </span>
    );
  }
```

- [ ] **Step 3: Pass onPreviewFromTab through all TabIcon call sites**

In the main render of `TabBar`, there are two places that render `<TabIcon tab={t} />` — the editing state and the normal trigger. Both need the prop:

```tsx
<TabIcon tab={t} onPreviewFromTab={onPreviewFromTab} />
```

- [ ] **Step 4: Build to verify**

Run: `npm run build`
Expected: no type errors

- [ ] **Step 5: Commit**

```bash
git add src/modules/tabs/TabBar.tsx
git commit -m "feat: add globe badge on tabs with detected preview URL"
```

---

### Task 6: PreviewUrlPill component

**Files:**

- Create: `src/modules/preview/PreviewUrlPill.tsx`
- Modify: `src/modules/preview/index.ts` — add export

**Interfaces:**

- Consumes: `Tab[]` (to find tabs with `previewUrl`), `onOpenPreview(url: string, spaceId: string)`
- Produces: rendered pill in Header

- [ ] **Step 1: Write the component**

```typescript
// src/modules/preview/PreviewUrlPill.tsx
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

  // Show the URL from the most recently active agent tab
  const activeHasUrl = urls.some((t) => t.id === activeId);
  const primary = urls[urls.length - 1]; // latest one added

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
```

- [ ] **Step 2: Export from preview/index.ts**

In `src/modules/preview/index.ts`, add at the end:

```typescript
export { PreviewUrlPill } from "./PreviewUrlPill";
```

- [ ] **Step 3: Build to verify**

Run: `npm run build`
Expected: no type errors

- [ ] **Step 4: Commit**

```bash
git add src/modules/preview/PreviewUrlPill.tsx src/modules/preview/index.ts
git commit -m "feat: add PreviewUrlPill component"
```

---

### Task 7: Wire everything in Header + App

**Files:**

- Modify: `src/modules/header/Header.tsx` — render PreviewUrlPill
- Modify: `src/app/App.tsx` — wire onPreviewFromTab and onDismiss callbacks

**Interfaces:**

- Consumes: `PreviewUrlPill` from Task 6, `openPreviewInSpace` from Task 3, TabBar `onPreviewFromTab` from Task 5
- Produces: functional end-to-end flow

- [ ] **Step 1: Add props to Header**

```typescript
// Add to Header Props:
  onOpenPreviewFromPill: (url: string, spaceId: string) => void;
  onDismissPreviewUrls: () => void;
  onPreviewFromTab?: (tabId: number, url: string, spaceId: string) => void;
```

Render `PreviewUrlPill` in the Header JSX, between `notificationBell` and the settings/search area:

```tsx
import { PreviewUrlPill } from "@/modules/preview";

// ...

// In the Header JSX, near the right side:
{notificationBell}
<PreviewUrlPill
  tabs={tabs}
  activeId={activeId}
  onOpenPreview={onOpenPreviewFromPill}
  onDismiss={onDismissPreviewUrls}
/>
```

Pass `onPreviewFromTab` to `TabBar`:

```tsx
<TabBar
  // ... existing props
  onPreviewFromTab={onPreviewFromTab}
/>
```

- [ ] **Step 2: Add callbacks in App.tsx**

```typescript
// In App.tsx, destructure openPreviewInSpace:
const {
  // ... existing
  openPreviewInSpace,
} = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

// Add callbacks:
const handleOpenPreviewInSpace = useCallback(
  (url: string, spaceId: string) => {
    openPreviewInSpace(url, spaceId);
  },
  [openPreviewInSpace],
);

const handleDismissPreviewUrls = useCallback(() => {
  for (const t of tabs) {
    if (t.kind === "terminal" && t.previewUrl) {
      updateTab(t.id, { previewUrl: undefined });
    }
  }
}, [tabs, updateTab]);

const handlePreviewFromTab = useCallback(
  (tabId: number, url: string, spaceId: string) => {
    // Could also set active tab to tabId, but just opening the preview is simpler
    openPreviewInSpace(url, spaceId);
  },
  [openPreviewInSpace],
);
```

Wire callbacks into Header:

```tsx
<Header
  // ... existing props
  onOpenPreviewFromPill={handleOpenPreviewInSpace}
  onDismissPreviewUrls={handleDismissPreviewUrls}
  onPreviewFromTab={handlePreviewFromTab}
/>
```

- [ ] **Step 3: Full build + typecheck**

Run: `npm run build`
Expected: clean build, no errors

- [ ] **Step 4: Commit**

```bash
git add src/modules/header/Header.tsx src/app/App.tsx
git commit -m "feat: wire PreviewUrlPill and tab globe badge into Header + App"
```

---

### Task 8: Integration smoke test

**Files:**

- Create: `src-tauri/tests/preview_url_integration.rs`

- [ ] **Step 1: Write integration test**

```rust
// src-tauri/tests/preview_url_integration.rs
use puhon::modules::pty::url_detect::UrlDetector;

#[test]
fn url_detector_basic_flow() {
    let mut d = UrlDetector::new();
    let mut urls = Vec::new();

    // Simulates "npm run dev" output with ANSI formatting
    d.process(
        b"\x1b[2J\x1b[H\n> my-app@0.1.0 dev\n> next dev\n\n  \x1b[32m✓ Ready in 2.3s\x1b[0m\n  Local:   \x1b[36mhttp://localhost:3000\x1b[0m\n",
        1,
        |u| urls.push(u),
    );

    assert_eq!(urls, vec!["http://localhost:3000"]);
    urls.clear();

    // Re-running the same output should dedup
    d.process(b"http://localhost:3000", 1, |u| urls.push(u));
    assert!(urls.is_empty());
}
```

- [ ] **Step 2: Run integration test**

Run: `cargo test --test preview_url_integration`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tests/preview_url_integration.rs
git commit -m "test: add integration test for UrlDetector with ANSI output"
```
