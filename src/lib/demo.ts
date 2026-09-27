export type Message = {
  id: string;
  role: "assistant" | "user" | "event";
  text: string;
  card?: "email";
};
export type DemoState = {
  version: 1;
  name: string;
  userName: string;
  inbox: boolean;
  messages: Message[];
  callWasActive: boolean;
};
export const STORAGE_KEY = "personatrial.frontend.v1";
export const message = (
  role: Message["role"],
  text: string,
  card?: Message["card"],
): Message => ({
  id: crypto.randomUUID(),
  role,
  text,
  ...(card ? { card } : {}),
});
export function initialState(): DemoState {
  return {
    version: 1,
    name: "Persona",
    userName: "",
    inbox: false,
    callWasActive: false,
    messages: [
      { id: "welcome", role: "assistant", text: "Hey, you. Glad you’re here." },
      {
        id: "introduction",
        role: "assistant",
        text: "I’m your little bit of extra headspace. First things first — what should you call me? Pick a name, or jump straight into what’s on your mind.",
      },
    ],
  };
}
export function isDemoState(value: unknown): value is DemoState {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<DemoState>;
  return (
    v.version === 1 &&
    typeof v.name === "string" &&
    v.name.length < 50 &&
    typeof v.userName === "string" &&
    typeof v.inbox === "boolean" &&
    typeof v.callWasActive === "boolean" &&
    Array.isArray(v.messages) &&
    v.messages.length < 1000 &&
    v.messages.every(
      (m) =>
        m &&
        typeof m.id === "string" &&
        ["assistant", "user", "event"].includes(m.role) &&
        typeof m.text === "string" &&
        (m.card === undefined || m.card === "email"),
    )
  );
}
// Deliberately local scripted responses. This adapter will be replaced by the backend.
export function replyTo(state: DemoState, input: string): DemoState {
  const text = input.trim().slice(0, 2000);
  if (!text) return state;
  let next = { ...state, messages: [...state.messages, message("user", text)] };
  const assistantName = text.match(
    /^(?:let[’']?s call you|your name is|i[’']?ll call you|call yourself)\s+(.+?)[.!]?$/i,
  );
  const userName = text.match(/^(?:my name is|call me)\s+(.+?)[.!]?$/i);
  let answer: string;
  let card: Message["card"];
  if (assistantName) {
    next.name = assistantName[1].trim().slice(0, 32);
    answer = `${next.name}. I like it. Want to tell me a little about yourself over a quick call? We can stay right here, too.`;
  } else if (userName) {
    next.userName = userName[1].trim().slice(0, 40);
    answer = `Got it, ${next.userName}. What’s one thing I could take off your mind today?`;
  } else if (
    /\b(no call|can[’']?t call|rather type|stay here|continue here|prefer text)\b/i.test(
      text,
    )
  ) {
    answer =
      "Right here works. Tell me what you need a hand with — no call required.";
  } else if (/\b(email|inbox|recruiter)\b/i.test(text)) {
    if (state.inbox) {
      answer =
        "Here’s the recruiter thread in the sample inbox. There’s an interview invitation and a request for your availability.";
      card = "email";
    } else
      answer =
        "Let’s find it. Open the sample inbox below to try the email flow, or paste an email here. Your real Gmail isn’t connected in this preview.";
  } else if (/\b(interview|prepare)\b/i.test(text)) {
    answer =
      "Let’s make it feel manageable. Start with a 60-second introduction: what you do, one project you’re proud of, and why this role interests you. Then choose two stories that show how you solve problems. What role are you preparing for?";
  } else if (/\b(draft|reply)\b/i.test(text)) {
    answer =
      "Here’s a starting point for the sample invitation:\n\nHi Alex,\nThanks for reaching out — I’d love to learn more about the role. Would Tuesday afternoon work for an introductory call?\nBest,\n[Your name]\n\nThis is a draft only. Nothing has been sent.";
  } else if (/\b(overwhelmed|plan|day|busy)\b/i.test(text)) {
    answer =
      "Let’s make some room. Write down the three things taking up the most space in your head. We’ll pick the one that matters today, and give the others somewhere to wait.";
  } else if (/\b(cancel|stop|never mind)\b/i.test(text)) {
    answer =
      "Okay, we can leave that there. What would you like to do instead?";
  } else {
    answer =
      "I’ve kept that here in our conversation. This preview has a few scripted paths to explore: planning your day, preparing for an interview, or finding a sample email. Which would you like to try?";
  }
  next = {
    ...next,
    messages: [...next.messages, message("assistant", answer, card)],
  };
  return next;
}
