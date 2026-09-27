import { useEffect, useRef, useState } from "react";
import type { ConversationMessage } from "@/shared/conversation";

export type OutgoingMessage = {
  eventId: string;
  text: string;
  status: "sending" | "sent" | "failed";
};

type Submit = (
  message: Pick<OutgoingMessage, "eventId" | "text">,
  signal: AbortSignal,
) => Promise<unknown>;

export function useOutgoingMessages(
  messages: ConversationMessage[],
  submit: Submit,
) {
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>([]);
  const active = useRef(true);
  const requests = useRef(new Map<string, AbortController>());
  const confirmed = new Set(messages.map((message) => message.clientEventId));

  useEffect(() => {
    active.current = true;
    const pending = requests.current;

    return () => {
      active.current = false;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, []);

  useEffect(() => {
    const saved = new Set(messages.map((message) => message.clientEventId));
    setOutgoing((previous) =>
      previous.filter((item) => !saved.has(item.eventId)),
    );
  }, [messages]);

  async function send(message: Pick<OutgoingMessage, "eventId" | "text">) {
    if (requests.current.has(message.eventId)) return;

    const controller = new AbortController();
    requests.current.set(message.eventId, controller);
    setOutgoing((previous) => {
      const pending: OutgoingMessage = { ...message, status: "sending" };
      return previous.some((item) => item.eventId === message.eventId)
        ? previous.map((item) =>
            item.eventId === message.eventId ? pending : item,
          )
        : [...previous, pending];
    });

    const timeout = setTimeout(() => controller.abort(), 10_000);
    let status: OutgoingMessage["status"] = "sent";

    try {
      await submit(message, controller.signal);
    } catch {
      status = "failed";
    } finally {
      clearTimeout(timeout);
      requests.current.delete(message.eventId);
      if (active.current) {
        setOutgoing((previous) =>
          previous.map((item) =>
            item.eventId === message.eventId ? { ...item, status } : item,
          ),
        );
      }
    }
  }

  return {
    outgoing: outgoing.filter((item) => !confirmed.has(item.eventId)),
    send,
  };
}
