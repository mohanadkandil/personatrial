export type Profile = {
  agentName?: string;
  userName?: string;
  helpRequest?: string;
  callPreference?: "offered" | "declined";
  gmailPreference?: "offered" | "declined";
};

export type TaskKind = "gmail.search" | "demo.search";
export type TaskStatus =
  "pending" | "running" | "completed" | "failed" | "cancelled";

export type ConversationMessage = {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  text: string;
  renderedAt: string | null;
};

export type Task = {
  id: string;
  evidenceId: string;
  kind: TaskKind;
  input: Record<string, unknown>;
  status: TaskStatus;
  revision: number;
};

export type ConversationSnapshot = {
  sequence: number;
  profile: Profile;
  gmailConnected: boolean;
  gmailSource: "personal" | "demo" | null;
  cursor: number;
  hasMore: boolean;
  messages: ConversationMessage[];
  tasks: Task[];
};
