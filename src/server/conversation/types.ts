export type {
  ConversationMessage,
  Task,
  TaskKind,
  TaskStatus,
} from "@/shared/conversation";

export type Scope = { ownerId: string; conversationId: string };
export type Channel = "chat" | "voice";
export type EndReason = "disconnect" | "hangup" | "goodbye" | "cancel";

export type Evidence = {
  id: string;
  sourceEventId: string;
  channel: Channel;
  callId: string | null;
  text: string;
  revision: number;
  final: boolean;
  sequence: number;
};

export class ConversationError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid_input" | "conflict",
  ) {
    super(code);
    this.name = "ConversationError";
  }
}
