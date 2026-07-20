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
