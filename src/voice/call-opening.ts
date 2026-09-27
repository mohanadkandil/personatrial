export type OpeningState = { active: boolean; ready: boolean };

export type CallOpening = {
  state: () => Promise<OpeningState>;
  uninterrupted: () => boolean;
  compose: () => Promise<string | null>;
  speak: (text: string) => void;
  wait: () => Promise<void>;
  attempts?: number;
};

export async function openCall(options: CallOpening): Promise<void> {
  for (let attempt = 0; attempt < (options.attempts ?? 150); attempt += 1) {
    const state = await options.state();

    if (!state.active || !options.uninterrupted()) return;

    if (!state.ready) {
      await options.wait();
      continue;
    }

    const greeting = await options.compose();
    const current = await options.state();

    if (greeting && current.active && current.ready && options.uninterrupted()) {
      options.speak(greeting);
    }

    return;
  }

  throw new Error("caller_audio_not_ready");
}
