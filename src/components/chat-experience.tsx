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
  ArrowUpRight,
  AudioLines,
  Check,
  ChevronRight,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Phone,
  PhoneOff,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Brand, Mark } from "./brand";
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
  const [muted, setMuted] = useState(false);
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
    setMuted(false);
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
    setMuted(false);
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
      <header className="site-header">
        <Brand />
        <div className="preview-badge">
          <span className="status-dot" /> INTERACTIVE PREVIEW
        </div>
        <Link href="/" className="back-link">
          <ArrowLeft size={15} /> Back to the idea
        </Link>
      </header>
      <div className="chat-stage">
        <aside className="stage-copy">
          <div className="eyebrow">YOUR OWN LITTLE CORNER</div>
          <h1>
            A conversation.
            <br />A little clarity.
            <br />
            <em>A fresh start.</em>
          </h1>
          <p>
            No perfect prompts.
            <br />
            No need to know where to begin.
            <br />
            Just start with what’s on your mind.
          </p>
          <div className="stage-note">
            <span className="note-line" />
            <span>
              Make it yours.
              <br />
              Even the name.
            </span>
          </div>
        </aside>
        <section
          className={`phone-shell ${call ? "in-call" : ""}`}
          aria-label="Your conversation"
        >
          <div className="phone-camera">
            <span />
          </div>
          <header className="conversation-header">
            <span className="avatar">
              <Mark small />
            </span>
            <div>
              <strong>{state.name}</strong>
              <span>
                <i className="status-dot" /> Here with you
              </span>
            </div>
            <div className="header-actions">
              <button
                ref={callTrigger}
                className="icon-button call-trigger"
                onClick={startCall}
                disabled={!ready || call}
                aria-label="Start voice preview"
              >
                <Phone size={19} />
              </button>
              <button
                className="icon-button"
                onClick={() => {
                  setEditedName(state.name);
                  setModal("settings");
                }}
                aria-label="Conversation settings"
              >
                <MoreHorizontal size={22} />
              </button>
            </div>
          </header>
          {call ? (
            <div className="call-screen">
              <div className="call-meta">
                VOICE PREVIEW{" "}
                <span>
                  {Math.floor(elapsed / 60)}:
                  {String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>
              <div className={`voice-orb ${speaking ? "speaking" : ""}`}>
                <div />
                <div />
                <div />
                <Mark />
              </div>
              <h2 ref={callHeading} tabIndex={-1}>
                {speaking ? "A familiar voice." : "A little closer."}
              </h2>
              <p>
                {speaking
                  ? `${state.name} is speaking…`
                  : `Say hello to ${state.name}.`}
              </p>
              <button
                className="play-voice"
                onClick={playGreeting}
                disabled={speaking}
              >
                <AudioLines size={17} />{" "}
                {speaking ? "Playing greeting" : "Play a sample greeting"}
              </button>
              <div className="call-disclaimer">
                Browser voice sample. Your microphone is off.
                <br />
                Live conversation comes with the backend.
              </div>
              {voiceNotice && (
                <p className="voice-notice" role="status">
                  {voiceNotice}
                </p>
              )}
              <div className="call-controls">
                <button
                  className={`round-control ${muted ? "selected" : ""}`}
                  aria-label={muted ? "Unmute playback" : "Mute playback"}
                  aria-pressed={muted}
                  onClick={() => {
                    if (!muted) {
                      window.speechSynthesis?.cancel();
                      setSpeaking(false);
                    }
                    setMuted(!muted);
                  }}
                >
                  {muted ? <VolumeX size={21} /> : <Volume2 size={21} />}
                </button>
                <button
                  className="round-control end-call"
                  aria-label="End voice preview"
                  onClick={endCall}
                >
                  <PhoneOff size={23} />
                </button>
                <button
                  className="round-control"
                  aria-label="Continue in chat"
                  onClick={endCall}
                >
                  <MessageCircle size={21} />
                </button>
              </div>
              <span className="end-call-hint">
                Pick up in chat, whenever you like.
              </span>
            </div>
          ) : (
            <>
              <div
                className="conversation-body"
                role="log"
                aria-label="Messages"
                aria-live="polite"
              >
                <div className="day-label">A NEW BEGINNING</div>
                {state.messages.map((m) =>
                  m.role === "event" ? (
                    <div className="event-message" key={m.id}>
                      <Check size={12} /> {m.text}
                    </div>
                  ) : (
                    <div key={m.id} className={`message-row ${m.role}`}>
                      {m.role === "assistant" && (
                        <span className="message-avatar">
                          <Mark small />
                        </span>
                      )}
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
                              Draft a reply <ArrowUpRight size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {state.messages.length === 2 && (
                  <div className="suggestions">
                    <button onClick={() => send("Let’s call you June")}>
                      Let’s call you June <ArrowUpRight size={12} />
                    </button>
                    <button onClick={() => send("Help me plan my day")}>
                      I could use a hand <ArrowUpRight size={12} />
                    </button>
                  </div>
                )}
                <div ref={bottom} />
              </div>
              <div className="composer-area">
                <button
                  className={`inbox-link ${state.inbox ? "added" : ""}`}
                  onClick={() => setModal("gmail")}
                >
                  <Mail size={14} />
                  <span>
                    {state.inbox
                      ? "Sample inbox available"
                      : "Give your assistant a little context"}
                  </span>
                  <ChevronRight size={14} />
                </button>
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
                <p className="composer-caption">
                  A little space to think out loud.
                </p>
              </div>
            </>
          )}
          <div className="home-indicator" />
        </section>
        <aside className="stage-caption">
          <span className="caption-plus">+</span>
          <p>
            A name you choose.
            <br />A conversation you shape.
          </p>
          <div className="caption-divider" />
          <span>TEXT. TALK. PICK UP HERE.</span>
        </aside>
      </div>
      <footer className="chat-footer">
        <span>
          {storageWarning
            ? "Browser storage unavailable · this session won’t survive refresh"
            : "Saved in this browser. Yours to reset."}
        </span>
        <div>
          <span>Scripted chat · sample voice · no Gmail access</span>
          <button onClick={() => setModal("reset")}>
            <RotateCcw size={12} /> Start fresh
          </button>
        </div>
      </footer>
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
            <ArrowRightIcon />
          </button>
          <button className="text-button" onClick={() => setModal(null)}>
            Maybe later
          </button>
        </Modal>
      )}
      {modal === "settings" && (
        <Modal title="Make it yours." close={() => setModal(null)}>
          <p>A name that feels right. You can always change it.</p>
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
          <div className="saved-facts">
            <span>YOUR CONTEXT</span>
            <p>
              {state.userName
                ? `You go by ${state.userName}.`
                : "Tell your assistant what to call you, whenever you’re ready."}
            </p>
            <p>
              {state.inbox
                ? "Using a fictional sample inbox."
                : "No inbox connected."}
            </p>
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
function ArrowRightIcon() {
  return <ArrowUpRight size={18} />;
}
