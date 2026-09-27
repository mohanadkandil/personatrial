"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  AudioLines,
  Check,
  Mail,
  RotateCcw,
  X,
} from "lucide-react";
import { Mark } from "./brand";
import { IPhone } from "./device/iphone";
import {
  initialState,
  isDemoState,
  message,
  replyTo,
  STORAGE_KEY,
  type DemoState,
} from "@/lib/demo";

function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <button
        className="icon-button modal-close"
        onClick={close}
        aria-label="Close dialog"
      >
        <X size={18} />
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export function ChatExperience() {
  const [state, setState] = useState<DemoState>(initialState);
  const [ready, setReady] = useState(false);
  const [input, setInput] = useState("");
  const [call, setCall] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState("");
  const [modal, setModal] = useState<"gmail" | "settings" | "reset" | null>(
    null,
  );
  const [editedName, setEditedName] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const callTrigger = useRef<HTMLButtonElement>(null);
  const callHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved: unknown = JSON.parse(raw);
        if (isDemoState(saved)) {
          if (saved.callWasActive) {
            saved.callWasActive = false;
            saved.messages.push(
              message("event", "Voice preview ended"),
              message(
                "assistant",
                "You’re back. Our messages are still here — we can pick up in chat.",
              ),
            );
          }
          setState(saved);
        }
      }
    } catch {
      setStorageWarning(true);
    }
    setReady(true);
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      setStorageWarning(true);
    }
  }, [state, ready]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [state.messages, call]);
  useEffect(() => {
    if (!call) return;
    callHeading.current?.focus();
    const id = window.setInterval(() => setElapsed((x) => x + 1), 1000);
    return () => window.clearInterval(id);
  }, [call]);

  function send(text: string) {
    if (!text.trim() || !ready) return;
    setState((previous) => replyTo(previous, text));
    setInput("");
    composer.current?.focus();
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    send(input);
  }
  function startCall() {
    if (!ready || call) return;
    setElapsed(0);
    setVoiceNotice("");
    setCall(true);
    setState((s) => ({ ...s, callWasActive: true }));
  }
  function endCall() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
    setCall(false);
    setState((s) => ({
      ...s,
      callWasActive: false,
      messages: [
        ...s.messages,
        message(
          "event",
          `Voice preview · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`,
        ),
        message(
          "assistant",
          "We can keep going here. Anything you’ve typed is still in our conversation.",
        ),
      ],
    }));
    requestAnimationFrame(() => callTrigger.current?.focus());
  }
  function playGreeting() {
    if (!("speechSynthesis" in window)) {
      setVoiceNotice(
        "Voice playback isn’t available in this browser. You can still explore the call and chat screens.",
      );
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      `Hey, I’m ${state.name === "Persona" ? "your Persona" : state.name}. What’s one thing I could help you with today?`,
    );
    utterance.rate = 0.92;
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      setVoiceNotice(
        "Playback stopped. You can try again or continue in chat.",
      );
    };
    setSpeaking(true);
    setVoiceNotice("");
    window.speechSynthesis.speak(utterance);
  }
  function useInbox() {
    setState((s) =>
      s.inbox
        ? s
        : {
            ...s,
            inbox: true,
            messages: [
              ...s.messages,
              message("event", "Sample inbox added · fictional messages"),
              message(
                "assistant",
                "The sample inbox is ready. There’s a recruiter invitation we can look at together. Want me to pull it up?",
              ),
            ],
          },
    );
    setModal(null);
  }

  return (
    <main className="chat-page">
      <Link href="/" className="canvas-back" aria-label="Back to Persona Trial">
        <ArrowLeft size={18} />
      </Link>
      <div className="chat-stage">
        <IPhone>
          <section className="phone-shell" aria-label="Your conversation">
            <header className="conversation-header">
              <span className="avatar">
                <Mark small />
              </span>
              <div>
                <button
                  className="contact-name"
                  onClick={() => {
                    setEditedName(state.name);
                    setModal("settings");
                  }}
                  aria-label="Conversation settings"
                  title="Conversation settings"
                >
                  {state.name}
                </button>
                <span>Preview</span>
              </div>
            </header>
            <>
              <div
                className="conversation-body"
                role="log"
                aria-label="Messages"
                aria-live="polite"
              >
                <div className="day-label">Today</div>
                {state.messages.map((m) =>
                  m.role === "event" ? (
                    <div className="event-message" key={m.id}>
                      <Check size={12} /> {m.text}
                    </div>
                  ) : (
                    <div key={m.id} className={`message-row ${m.role}`}>
                      <div className="message-content">
                        <div className="message-bubble">{m.text}</div>
                        {m.card === "email" && (
                          <div className="email-card">
                            <span className="sample-label">SAMPLE EMAIL</span>
                            <div className="email-sender">
                              <span>A</span>
                              <div>
                                <strong>Alex Morgan</strong>
                                <small>Recruiting at Acme Studio</small>
                              </div>
                              <span className="email-time">10:42</span>
                            </div>
                            <h3>Let’s find a time to meet</h3>
                            <p>
                              We’d love to hear more about your work. Are you
                              available for a short introductory call next week?
                            </p>
                            <button
                              onClick={() => send("Draft a reply")}
                              aria-label="Draft a reply to sample email"
                            >
                              Draft a reply
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}
                <div ref={bottom} />
              </div>
              <div className="composer-area">
                <form className="composer" onSubmit={submit}>
                  <textarea
                    ref={composer}
                    aria-label={`Message ${state.name}`}
                    placeholder={`Message ${state.name}…`}
                    value={input}
                    maxLength={2000}
                    rows={1}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        send(input);
                      }
                    }}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || !ready}
                    aria-label="Send message"
                  >
                    <ArrowUp size={19} />
                  </button>
                </form>
                <p className="composer-caption">Scripted preview</p>
              </div>
            </>
          </section>
        </IPhone>
        <aside
          className={`voice-dock ${call ? "active" : ""}`}
          aria-label="Website call controls"
        >
          {call ? (
            <>
              <div
                className={`voice-orb ${speaking ? "speaking" : ""}`}
                aria-hidden="true"
              >
                <div />
                <div />
                <div />
                <Mark />
              </div>
              <h2 ref={callHeading} tabIndex={-1}>
                {state.name}
              </h2>
              <p className="voice-time">
                Voice preview <span>·</span> {Math.floor(elapsed / 60)}:
                {String(elapsed % 60).padStart(2, "0")}
              </p>
              <div className="voice-links">
                <button
                  className="quiet-link"
                  onClick={() => {
                    if (speaking) {
                      window.speechSynthesis?.cancel();
                      setSpeaking(false);
                    } else playGreeting();
                  }}
                  aria-label={
                    speaking ? "Stop sample greeting" : "Play a sample greeting"
                  }
                >
                  {speaking ? "Stop audio" : "Hear a greeting"}
                  <AudioLines size={14} />
                </button>
                <button
                  className="quiet-link end-voice"
                  onClick={endCall}
                  aria-label="End voice preview"
                >
                  End call
                  <X size={13} />
                </button>
              </div>
              <p className="voice-disclaimer">
                Sample audio. Your microphone is off.
              </p>
              {voiceNotice && (
                <p className="voice-notice" role="status">
                  {voiceNotice}
                </p>
              )}
            </>
          ) : (
            <div className="call-invitation">
              <span>Want to call?</span>
              <button
                ref={callTrigger}
                className="quiet-link"
                disabled={!ready}
                onClick={startCall}
                aria-label="Start voice preview"
              >
                Press here
              </button>
            </div>
          )}
        </aside>
      </div>
      {storageWarning && (
        <p className="storage-warning" role="status">
          Browser storage unavailable. This conversation won’t survive refresh.
        </p>
      )}
      {modal === "gmail" && (
        <Modal title="A little more context." close={() => setModal(null)}>
          <div className="modal-icon">
            <Mail size={26} />
          </div>
          <p>
            When Gmail is connected, your Persona can help find the things
            buried in your inbox.
          </p>
          <div className="honest-note">
            <span className="status-dot" />
            <p>
              This frontend preview uses fictional emails. It doesn’t connect to
              Google or read your inbox.
            </p>
          </div>
          <button className="primary-button modal-primary" onClick={useInbox}>
            {state.inbox ? "Back to the conversation" : "Try the sample inbox"}
          </button>
          <button className="text-button" onClick={() => setModal(null)}>
            Maybe later
          </button>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Make it yours." close={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (editedName.trim()) {
                setState((s) => ({
                  ...s,
                  name: editedName.trim().slice(0, 32),
                  messages: [
                    ...s.messages,
                    message(
                      "event",
                      `Your assistant is now ${editedName.trim().slice(0, 32)}`,
                    ),
                  ],
                }));
                setModal(null);
              }
            }}
          >
            <label className="field-label" htmlFor="assistant-name">
              Your assistant’s name
            </label>
            <input
              id="assistant-name"
              className="name-input"
              maxLength={32}
              value={editedName}
              onChange={(e) => setEditedName(e.target.value)}
              autoComplete="off"
            />
            <button
              className="primary-button modal-primary"
              disabled={!editedName.trim()}
            >
              Save name <Check size={17} />
            </button>
          </form>
          <div className="settings-actions">
            <button className="text-button" onClick={() => setModal("gmail")}>
              <Mail size={16} /> Sample inbox
            </button>
            <button className="text-button" onClick={() => setModal("reset")}>
              <RotateCcw size={16} /> Start fresh
            </button>
          </div>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal title="A fresh conversation?" close={() => setModal(null)}>
          <p>
            This clears the messages, names, and sample inbox saved in this
            browser.
          </p>
          <button
            className="primary-button modal-primary"
            onClick={() => {
              window.speechSynthesis?.cancel();
              setSpeaking(false);
              setState(initialState());
              setInput("");
              setCall(false);
              setModal(null);
            }}
          >
            Start fresh <RotateCcw size={16} />
          </button>
          <button className="text-button" onClick={() => setModal(null)}>
            Keep this conversation
          </button>
        </Modal>
      )}
    </main>
  );
}
