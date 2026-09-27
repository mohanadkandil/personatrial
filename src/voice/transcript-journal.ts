export interface TranscriptWrite {
  sourceEventId: string;
  channel: "voice";
  callId: string;
  text: string;
  revision: number;
  final: boolean;
}

export interface TranscriptJournalOptions {
  callId: string;
  append: (input: TranscriptWrite) => Promise<{ id: string }>;
  onFinal: (evidenceId: string, generation: number) => Promise<void>;
  onFailure: (
    code: "transcript_write_failed" | "turn_failed" | "transcript_limit",
  ) => void;
}

type Fragment = {
  text: string;
  revision: number;
  final: boolean;
  failed: boolean;
  generation: number;
};

/** Journals provider transcript events, not audio that the provider never received.
 * Raw events avoid the SDK's synthesized final event after transcription failure.
 * Database writes remain independent of the response-generation queue.
 */
export class TranscriptJournal {
  private readonly items = new Map<string, Fragment>();
  private readonly seenEvents = new Set<string>();
  private writes: Promise<void> = Promise.resolve();
  private readonly turns = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly options: TranscriptJournalOptions) {}

  receive(raw: unknown, generation: number): void {
    if (this.stopped || !raw || typeof raw !== "object") {
      return;
    }

    const event = raw as Record<string, unknown>;
    const type = event.type;

    if (
      type !== "conversation.item.input_audio_transcription.delta" &&
      type !== "conversation.item.input_audio_transcription.completed" &&
      type !== "conversation.item.input_audio_transcription.failed"
    ) {
      return;
    }

    if (
      typeof event.item_id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(event.item_id)
    ) {
      return;
    }

    const index = event.content_index ?? 0;

    if (
      !Number.isSafeInteger(index) ||
      Number(index) < 0 ||
      Number(index) > 10
    ) {
      return;
    }

    if (typeof event.event_id === "string") {
      if (this.seenEvents.has(event.event_id)) {
        return;
      }

      this.seenEvents.add(event.event_id);

      if (this.seenEvents.size > 10_000) {
        const first = this.seenEvents.values().next().value;

        if (first !== undefined) {
          this.seenEvents.delete(first);
        }
      }
    }

    const sourceEventId = `voice:${this.options.callId}:${event.item_id}:${index}`;
    let item = this.items.get(sourceEventId);

    if (!item) {
      if (this.items.size >= 1000) {
        this.options.onFailure("transcript_limit");
        return;
      }

      item = { text: "", revision: 0, final: false, failed: false, generation };
      this.items.set(sourceEventId, item);
    }

    if (item.final || item.failed) {
      return;
    }

    if (type.endsWith(".failed")) {
      item.failed = true;
      return;
    }

    const isDelta = type.endsWith(".delta");
    const incoming = isDelta ? event.delta : event.transcript;

    if (typeof incoming !== "string") {
      return;
    }

    const text = isDelta ? item.text + incoming : incoming;

    if (text.length > 8000) {
      item.failed = true;
      this.options.onFailure("transcript_limit");
      return;
    }

    const final =
      !isDelta && (event.status === undefined || event.status === "completed");

    if (!text.trim() || (text === item.text && !final)) {
      return;
    }

    item.text = text;
    item.final = final;
    item.revision += 1;

    const input: TranscriptWrite = {
      sourceEventId,
      channel: "voice",
      callId: this.options.callId,
      text,
      revision: item.revision,
      final,
    };
    const inputGeneration = item.generation;

    this.writes = this.writes
      .then(async () => {
        const evidence = await this.options.append(input);

        if (final) {
          // Do not await the response model here: the next transcript must be saved now.
          const turn = Promise.resolve()
            .then(() => this.options.onFinal(evidence.id, inputGeneration))
            .catch(() => this.options.onFailure("turn_failed"));

          this.turns.add(turn);
          void turn.finally(() => this.turns.delete(turn));
        }
      })
      .catch(() => {
        this.options.onFailure("transcript_write_failed");
      });
  }

  /** Await writes already received. Does not wait for response generation. */
  async drain(): Promise<void> {
    await this.writes;
  }

  /** Call only after closing the provider stream, so late finals remain admissible. */
  async close(): Promise<void> {
    this.stopped = true;
    await this.drain();
  }

  async settleTurns(): Promise<void> {
    await Promise.allSettled([...this.turns]);
  }
}
