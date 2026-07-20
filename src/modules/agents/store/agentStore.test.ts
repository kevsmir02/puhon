import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore, nextAttentionTarget } from "@/modules/agents/store/agentStore";

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
