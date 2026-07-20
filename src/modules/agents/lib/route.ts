import { usePreferencesStore } from "@/modules/settings/preferences";
import { showAgentToast } from "@/modules/agents/components/AgentToast";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import { osNotify } from "@/modules/agents/lib/notify";
import type { NotificationKind } from "@/modules/agents/lib/types";

type RouteArgs = {
  agent: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  focused: boolean;
  visible: boolean;
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
