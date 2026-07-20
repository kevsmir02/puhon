import { beforeEach, describe, expect, it, vi } from "vitest";
import { routeAgentNotification } from "@/modules/agents/lib/route";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { osNotify } from "@/modules/agents/lib/notify";
import { showAgentToast } from "@/modules/agents/components/AgentToast";

vi.mock("@/modules/agents/lib/notify", () => ({ osNotify: vi.fn() }));
vi.mock("@/modules/agents/components/AgentToast", () => ({ showAgentToast: vi.fn() }));

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
    vi.mocked(osNotify).mockClear();
    routeAgentNotification({
      agent: "codex", kind: "finished", title: "t", body: "b",
      focused: false, visible: false, allowToast: false, onActivate: () => {},
    });
    expect(osNotify).toHaveBeenCalledWith("t", "b");
    expect(useAgentStore.getState().notifications).toHaveLength(1);
  });

  it("toasts when focused but hidden and allowToast", () => {
    vi.mocked(showAgentToast).mockClear();
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
