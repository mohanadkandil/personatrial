"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUp, X } from "lucide-react";
import { Room, RoomEvent, Track } from "livekit-client";
import type {
  ConversationMessage,
  Profile,
  ConversationSnapshot,
} from "@/shared/conversation";
import { IPhone } from "./device/iphone";
import { VoiceOrb } from "./voice-orb";
import {
  useOutgoingMessages,
  type OutgoingMessage,
} from "./chat/use-outgoing-messages";

type CallAttempt = {
  controller: AbortController;
  connection: Room | null;
  callId: string | null;
  phase: "connecting" | "connected";
  ended: boolean;
  endReason: "hangup" | "cancel" | null;
};

async function releaseCall(attempt: CallAttempt) {
  await Promise.allSettled([
    attempt.connection?.disconnect(),
    attempt.callId && attempt.endReason
      ? request("/api/call", {
          action: "end",
          callId: attempt.callId,
          reason: attempt.endReason,
        })
      : Promise.resolve(),
  ]);
}

async function request<T>(
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (url === "/api/gmail") {
      const body = await response.json().catch(() => null);

      if (typeof body?.message === "string") {
        throw new Error(body.message);
      }
    }

    throw new Error(
      response.status === 429
        ? "A lot arrived at once. Please wait a moment and try again."
        : "Couldn’t connect. Your saved messages will return when we reconnect.",
    );
  }

  return response.json();
}

function submitChatMessage(
  message: Pick<OutgoingMessage, "eventId" | "text">,
  signal: AbortSignal,
) {
  return request("/api/conversation", { type: "message", ...message }, signal);
}

type GmailConnection = { attemptId: string; connectUrl: string };

export function LiveChatExperience() {
  const [conversation, setConversation] = useState<{
    generation: number;
    snapshot: ConversationSnapshot | null;
    connection?: GmailConnection;
    notice?: string;
  }>({ generation: 0, snapshot: null });

  async function reset(
    connectDifferentGmail = false,
    popup: Window | null = null,
  ) {
    const snapshot = await request<ConversationSnapshot>("/api/conversation", {
      type: "reset",
      disconnectGmail: connectDifferentGmail,
    });

    let connection: GmailConnection | undefined;
    let notice = "";

    if (connectDifferentGmail) {
      try {
        connection = await request<GmailConnection>("/api/gmail", {
          action: "start",
        });
        notice =
          "Connect your Gmail in the new tab. This conversation will use your inbox.";
        if (popup) popup.location.href = connection.connectUrl;
      } catch (error) {
        popup?.close();
        notice =
          error instanceof Error
            ? error.message
            : "Gmail couldn’t connect. Please try again.";
      }
    }

    setConversation((previous) => ({
      generation: previous.generation + 1,
      snapshot,
      connection,
      notice,
    }));
  }

  return (
    <Conversation
      key={conversation.generation}
      initialSnapshot={conversation.snapshot}
      initialConnection={conversation.connection}
      initialNotice={conversation.notice}
      onReset={reset}
    />
  );
}

function Conversation({
  initialSnapshot,
  initialConnection,
  initialNotice,
  onReset,
}: {
  initialSnapshot: ConversationSnapshot | null;
  initialConnection?: GmailConnection;
  initialNotice?: string;
  onReset: (
    connectDifferentGmail?: boolean,
    popup?: Window | null,
  ) => Promise<void>;
}) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [profile, setProfile] = useState<Profile>({});
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState(initialNotice ?? "");
  const [ready, setReady] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [callState, setCallState] = useState<
    "idle" | "connecting" | "connected"
  >("idle");
  const [elapsed, setElapsed] = useState(0);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailSource, setGmailSource] = useState<"personal" | "demo" | null>(
    null,
  );
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailAttempt, setGmailAttempt] = useState<string | null>(
    initialConnection?.attemptId ?? null,
  );
  const [connectUrl, setConnectUrl] = useState<string | null>(
    initialConnection?.connectUrl ?? null,
  );
  const bootstrap = useRef<Promise<ConversationSnapshot> | null>(
    initialSnapshot ? Promise.resolve(initialSnapshot) : null,
  );
  const cursor = useRef(0);
  const callAttempt = useRef<CallAttempt | null>(null);
  const audio = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const name = profile.agentName ?? "Persona";
  const { outgoing, send: sendOutgoing } = useOutgoingMessages(
    messages,
    submitChatMessage,
  );

  const applySnapshot = useCallback((snapshot: ConversationSnapshot) => {
    setMessages((previous) => {
      if (snapshot.messages.length === 0) return previous;

      const merged = new Map(previous.map((message) => [message.id, message]));

      for (const message of snapshot.messages) merged.set(message.id, message);

      return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
    });

    cursor.current = snapshot.cursor;
    setProfile(snapshot.profile);
    setGmailConnected(snapshot.gmailConnected);
    setGmailSource(snapshot.gmailSource ?? null);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        let snapshot: ConversationSnapshot;

        do {
          snapshot = await request<ConversationSnapshot>(
            `/api/conversation?after=${cursor.current}`,
          );

          if (stopped) return;

          applySnapshot(snapshot);
        } while (snapshot.hasMore);
      } catch {
        if (!stopped)
          setNotice("Connection interrupted. I’ll keep trying to reconnect.");
      } finally {
        if (!stopped) timer = setTimeout(poll, 1500);
      }
    }

    bootstrap.current ??= request<ConversationSnapshot>("/api/conversation", {
      type: "bootstrap",
    });

    bootstrap.current
      .then((snapshot) => {
        if (stopped) return;

        applySnapshot(snapshot);
        setReady(true);
        void poll();
      })
      .catch(() => {
        if (!stopped)
          setNotice("The conversation couldn’t load. Refresh to try again.");
      });

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [applySnapshot]);

  useEffect(() => {
    const ids = messages
      .filter((message) => !message.renderedAt)
      .map((message) => message.id)
      .slice(-100);

    if (!ids.length || document.visibilityState !== "visible") return;

    const frame = requestAnimationFrame(() => {
      void request("/api/conversation", { type: "ack", messageIds: ids })
        .then(() => {
          const rendered = new Set(ids);

          setMessages((previous) =>
            previous.map((message) =>
              rendered.has(message.id)
                ? { ...message, renderedAt: new Date().toISOString() }
                : message,
            ),
          );
        })
        .catch(() => {});
    });

    return () => cancelAnimationFrame(frame);
  }, [messages]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [messages, outgoing.length]);

  useEffect(() => {
    if (callState !== "connected") return;

    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);

    return () => clearInterval(timer);
  }, [callState]);

  useEffect(
    () => () => {
      const attempt = callAttempt.current;

      if (!attempt) return;

      callAttempt.current = null;
      attempt.ended = true;
      attempt.endReason = attempt.phase === "connecting" ? "cancel" : null;
      attempt.controller.abort();
      void releaseCall(attempt);
    },
    [],
  );

  useEffect(() => {
    if (!ready || gmailConnected) return;

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function checkConnection() {
      try {
        const status = await request<{
          connected: boolean;
          attempt: { id: string; status: string; expiresAt: string } | null;
        }>("/api/gmail");

        if (stopped) return;

        if (status.connected) {
          setGmailConnected(true);
          setGmailAttempt(null);
          setConnectUrl(null);
          setNotice("Gmail is connected.");
          return;
        }

        if (status.attempt?.status === "pending") {
          setGmailAttempt(status.attempt.id);

          const result = await request<{ connected: boolean }>("/api/gmail", {
            action: "confirm",
            attemptId: status.attempt.id,
          });

          if (!stopped && result.connected) {
            setGmailConnected(true);
            setGmailAttempt(null);
            setConnectUrl(null);
            setNotice("Gmail is connected.");
            return;
          }
        } else {
          setGmailAttempt(null);
        }
      } catch {
        // A provider outage must not interrupt the conversation.
      }

      if (!stopped) timer = setTimeout(checkConnection, 4000);
    }

    void checkConnection();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [ready, gmailConnected, gmailAttempt]);

  function send(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();

    if (!text || !ready) return;

    setInput("");
    setNotice("");
    void sendOutgoing({ text, eventId: crypto.randomUUID() });
  }

  function stopCall(
    attempt: CallAttempt,
    reason: CallAttempt["endReason"],
    message?: string,
  ) {
    if (!attempt.ended) {
      attempt.ended = true;
      attempt.endReason = reason;
    }

    if (callAttempt.current === attempt) {
      callAttempt.current = null;
      setCallState("idle");

      if (message) setNotice(message);
    }

    attempt.controller.abort();
    void releaseCall(attempt);
  }

  async function startCall() {
    if (callAttempt.current) return;

    const attempt: CallAttempt = {
      controller: new AbortController(),
      connection: null,
      callId: null,
      phase: "connecting",
      ended: false,
      endReason: null,
    };

    callAttempt.current = attempt;
    setCallState("connecting");
    setNotice("");

    const current = () =>
      callAttempt.current === attempt && !attempt.controller.signal.aborted;
    const assertCurrent = () => {
      if (!current()) throw new Error("call_attempt_ended");
    };
    const deadline = setTimeout(() => attempt.controller.abort(), 30_000);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("call_attempt_ended"));
      attempt.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });

    async function connect() {
      const admission = await request<{
        callId: string;
        url: string;
        token: string;
      }>("/api/call", { action: "start" });

      attempt.callId = admission.callId;

      if (!current()) {
        await releaseCall(attempt);
        return;
      }

      const connection = new Room();
      attempt.connection = connection;
      let audioSubscribed!: () => void;
      const agentAudio = new Promise<void>((resolve) => {
        audioSubscribed = resolve;
      });

      connection.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio && current()) {
          audio.current?.appendChild(track.attach());
          audioSubscribed();
        }
      });

      connection.on(RoomEvent.TrackUnsubscribed, (track) =>
        track.detach().forEach((element) => element.remove()),
      );
      connection.on(RoomEvent.Disconnected, () => {
        if (!current()) return;

        stopCall(
          attempt,
          attempt.phase === "connecting" ? "cancel" : null,
          "The call disconnected. We can continue here.",
        );
      });

      await connection.connect(admission.url, admission.token);
      assertCurrent();
      await connection.startAudio();
      assertCurrent();
      await connection.localParticipant.setMicrophoneEnabled(true);

      if (!current()) {
        await connection.localParticipant
          .setMicrophoneEnabled(false)
          .catch(() => {});
        await releaseCall(attempt);
        return;
      }

      await Promise.race([agentAudio, aborted]);
      assertCurrent();
      await connection.startAudio();
      assertCurrent();

      if (!connection.canPlaybackAudio)
        throw new Error("audio_playback_blocked");

      await request("/api/call", { action: "ready", callId: admission.callId });
      assertCurrent();
      attempt.phase = "connected";
      setElapsed(0);
      setCallState("connected");
    }

    try {
      await Promise.race([connect(), aborted]);
    } catch {
      stopCall(
        attempt,
        "cancel",
        "The call couldn’t connect. Check microphone permission, or keep chatting here.",
      );
    } finally {
      clearTimeout(deadline);
      attempt.controller.signal.removeEventListener("abort", onAbort);
    }
  }

  function endCall() {
    const attempt = callAttempt.current;

    if (attempt) {
      stopCall(attempt, attempt.phase === "connecting" ? "cancel" : "hangup");
    }
  }

  async function resetConversation(connectDifferentGmail = false) {
    if (resetting || gmailBusy || !ready) return;

    const popup = connectDifferentGmail
      ? window.open("about:blank", "_blank")
      : null;
    if (popup) popup.opener = null;
    setGmailBusy(connectDifferentGmail);

    setResetting(true);
    setReady(false);
    setNotice("");
    endCall();
    audio.current?.replaceChildren();

    try {
      await onReset(connectDifferentGmail, popup);
    } catch {
      popup?.close();
      setGmailBusy(false);
      setNotice("Couldn’t reset the conversation. Please try again.");
      setResetting(false);
      setReady(true);
    }
  }

  return (
    <main className="chat-page">
      <Link href="/" className="canvas-back" aria-label="Back to Persona Trial">
        <ArrowLeft size={18} />
      </Link>
      <div className="conversation-actions">
        {gmailConnected && (
          <span
            className="mailbox-badge"
            title={
              gmailSource === "demo"
                ? "This demo uses Mohanad’s personal Gmail, with read-only access. Connect Gmail to clear this conversation and use your own account."
                : "Your Gmail is connected. Connect Gmail to clear this conversation and switch accounts."
            }
          >
            <span className="mailbox-badge-dot" aria-hidden="true" />
            {gmailSource === "demo"
              ? "Using Mohanad’s Gmail"
              : "Your Gmail is connected"}
          </span>
        )}
        <button
          type="button"
          className="conversation-reset"
          title="Clear this conversation and connect a different Gmail account."
          disabled={!ready || resetting || gmailBusy}
          onClick={() => void resetConversation(true)}
        >
          {gmailBusy ? "Connecting…" : "Connect Gmail"}
        </button>
        <button
          type="button"
          className="conversation-reset"
          aria-label="Reset conversation"
          title="Clear this conversation and start again. Gmail stays connected."
          disabled={!ready || resetting || gmailBusy}
          onClick={() => void resetConversation()}
        >
          {resetting && !gmailBusy ? "Resetting…" : "Reset"}
        </button>
      </div>
      <div className="chat-stage">
        <IPhone>
          <section className="phone-shell" aria-label="Your conversation">
            <div
              className="conversation-body"
              role="log"
              aria-label="Messages"
              aria-live="polite"
            >
              <div className="day-label">Today</div>
              {ready && (
                <div className="message-row assistant">
                  <div className="message-bubble">
                    Hey 👋 What would you like to call me?
                  </div>
                </div>
              )}
              {messages.map((message) => (
                <div key={message.id} className={`message-row ${message.role}`}>
                  <div className="message-content">
                    <div className="message-bubble">{message.text}</div>
                  </div>
                </div>
              ))}
              {outgoing.map((message) => (
                <div key={message.eventId} className="message-row user">
                  <div className="message-content">
                    <div className="message-bubble">{message.text}</div>
                    <div className="message-send-status" role="status">
                      {message.status === "failed" ? (
                        <>
                          Couldn’t confirm ·{" "}
                          <button
                            type="button"
                            aria-label="Retry sending message"
                            onClick={() => void sendOutgoing(message)}
                          >
                            Retry
                          </button>
                        </>
                      ) : message.status === "sending" ? (
                        "Sending…"
                      ) : (
                        "Sent"
                      )}
                    </div>
                  </div>
                </div>
              ))}
              <div ref={bottom} />
            </div>
            <div className="composer-area">
              <form className="composer" onSubmit={send}>
                <textarea
                  aria-label={`Message ${name}`}
                  placeholder={`Message ${name}…`}
                  value={input}
                  maxLength={8000}
                  rows={1}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={!ready || !input.trim()}
                  aria-label="Send message"
                >
                  <ArrowUp size={19} />
                </button>
              </form>
              <p className="composer-caption">
                {notice || "Voice and chat, one conversation"}
              </p>
              {!gmailConnected && ready && connectUrl && gmailAttempt && (
                <p className="composer-caption">
                  <a
                    href={connectUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    Continue Gmail connection
                  </a>
                </p>
              )}
            </div>
          </section>
        </IPhone>
        <aside
          className={`voice-dock ${callState !== "idle" ? "active" : ""}`}
          aria-label="Website call controls"
        >
          {callState === "idle" ? (
            <div className="call-invitation">
              <span>Want to call?</span>
              <button
                className="quiet-link"
                disabled={!ready}
                onClick={() => void startCall()}
              >
                Press here
              </button>
            </div>
          ) : (
            <>
              <VoiceOrb />
              <h2>{name}</h2>
              <p className="voice-time">
                {callState === "connecting"
                  ? "Connecting…"
                  : `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}
              </p>
              <button
                className="quiet-link end-voice"
                onClick={() => void endCall()}
              >
                {callState === "connecting" ? "Cancel call" : "End call"}{" "}
                <X size={13} />
              </button>
            </>
          )}
        </aside>
      </div>
      <div ref={audio} hidden />
    </main>
  );
}
