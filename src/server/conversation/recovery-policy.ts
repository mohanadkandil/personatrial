import type { Profile } from "@/shared/conversation";
import type { EndReason, TaskKind, TaskStatus } from "./types";

export type RecoveryContext = {
  sequence: number;
  callId: string;
  reason: EndReason;
  profile: Profile;
  dialogue: { role: "user" | "assistant"; text: string }[];
  lastInputPartial: boolean;
  task: { kind: TaskKind; status: TaskStatus; query: string } | null;
};

export function recoveryFallback(context: RecoveryContext): string {
  if (context.task && ["pending", "running"].includes(context.task.status)) {
    const subject =
      context.task.kind === "gmail.search"
        ? "Gmail search"
        : "sample inbox search";

    return `I’m still working on your ${subject} and will send the result here. No need to stay on the call.`;
  }

  if (context.lastInputPartial) {
    return "I missed the end of what you were saying. Want to finish your thought here?";
  }

  if (context.profile.callPreference === "declined") {
    return "We can carry on here whenever you’re ready. What would you like to pick up?";
  }

  return context.reason === "disconnect"
    ? "Looks like we lost the connection. Want to pick up here, or try the call again?"
    : "Want to carry on here, or talk again when it suits you?";
}
