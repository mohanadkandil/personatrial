import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AutoSubscribe,
  cli,
  defineAgent,
  llm,
  ServerOptions,
  voice,
  type JobContext,
} from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { getDatabase } from "../server/database";
import { ConversationService } from "../server/conversation/service";
import { dispatchJobs } from "../server/jobs/functions";
import { verifyVoiceSession } from "./session-auth";
import { TranscriptJournal } from "./transcript-journal";
import { openCall } from "./call-opening";
import { createVoiceTools } from "./tools";
import { voiceInstructions, callGreetingInstructions } from "../prompts/voice";
import {
  VoiceToolService,
  VoiceToolError,
  type VoiceAction,
} from "../server/conversation/voice-tools";

const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || "persona-onboarding";
const FINAL_TRANSCRIPT_GRACE_MS = 1500;

function report(code: string): void {
  // Codes only. Provider errors can contain transcripts, credentials and user identifiers.
  console.error(`[persona-voice] ${code}`);
}

/** Public model/session hooks expose raw events before SDK transcript normalization. */
class JournaledRealtimeModel extends openai.realtime.RealtimeModel {
  activeSession?: openai.realtime.RealtimeSession;

  constructor(private readonly receive: (event: unknown) => void) {
    super({
      model: process.env.OPENAI_REALTIME_MODEL || "gpt-realtime",
      voice: process.env.OPENAI_REALTIME_VOICE || "marin",
      inputAudioTranscription: { model: "gpt-4o-mini-transcribe" },
      turnDetection: {
        type: "semantic_vad",
        eagerness: "medium",
        create_response: true,
        interrupt_response: true,
      },
      toolChoice: "auto",
    });
  }

  override session(): openai.realtime.RealtimeSession {
    const session = super.session();

    this.activeSession = session;
    session.on("openai_server_event_received", this.receive);

    return session;
  }
}

async function contextForCall(
  service: ConversationService,
  scope: {
    ownerId: string;
    conversationId: string;
  },
): Promise<llm.ChatContext> {
  const history = await service.history(scope);
  const context = llm.ChatContext.empty();

  for (const message of history.slice(-30)) {
    context.addMessage({ role: message.role, content: message.text });
  }

  return context;
}

async function enterCall(ctx: JobContext): Promise<void> {
  const secret = process.env.VOICE_SESSION_SECRET;
  const roomName = ctx.job.room?.name;

  if (!secret || !roomName) {
    throw new Error("voice_configuration_missing");
  }

  // Dispatch metadata is signed by our authenticated API. Participant metadata is ignored.
  const claims = verifyVoiceSession(ctx.job.metadata, secret, roomName);
  const scope = {
    ownerId: claims.ownerId,
    conversationId: claims.conversationId,
  };
  const database = getDatabase();
  const service = new ConversationService(database);
  const chatCtx = await contextForCall(service, scope);
  const toolService = new VoiceToolService(database);
  const [conversation] =
    await database`SELECT last_chat_sequence FROM conversations
    WHERE id = ${scope.conversationId} AND owner_id = ${scope.ownerId}`;

  let lastChatSequence = Number(conversation.last_chat_sequence);

  // Reject replay of an already-ended call; acceptTask ownership is checked separately.
  await service.startCall(scope, claims.callId);

  let active = true;
  let started = false;
  let generation = 0;
  let committedGeneration = 0;
  let inputAudioPending = false;
  let shutdown: Promise<void> | undefined;
  let session: voice.AgentSession | undefined;
  let model: JournaledRealtimeModel | undefined;
  let lifecycleTimer: ReturnType<typeof setInterval> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  const itemGenerations = new Map<string, number>();

  const playbackState = async () => {
    const [state] =
      await database`SELECT calls.status, calls.ready_at, conversations.last_chat_sequence, conversations.sequence
      FROM calls JOIN conversations ON conversations.id = calls.conversation_id
      WHERE calls.id = ${claims.callId} AND conversations.id = ${scope.conversationId}
        AND conversations.owner_id = ${scope.ownerId}`;

    return {
      active: active && state?.status === "active",
      ready: Boolean(state?.ready_at),
      chatSequence: Number(state?.last_chat_sequence),
      sequence: Number(state?.sequence),
    };
  };

  const inputs = new Map<
    number,
    { token: string; ready: Promise<void>; evidenceId?: string }
  >();
  const responseGenerations = new Map<string, number>();
  const toolGenerations = new Map<string, number>();
  let inputWrites: Promise<void> = Promise.resolve();
  let assistantWrites: Promise<void> = Promise.resolve();

  const currentContext = async () => {
    const snapshot = await service.snapshot(scope);

    return {
      profile: snapshot.profile,
      gmailConnected: snapshot.gmailConnected,
      gmailSource: snapshot.gmailSource,
      tasks: snapshot.tasks,
      recentMessages: snapshot.messages.slice(-8),
    };
  };

  const executeTool = async (
    action: VoiceAction,
    toolCallId: string,
    signal: AbortSignal,
  ) => {
    const inputGeneration = toolGenerations.get(toolCallId);
    const input =
      inputGeneration === undefined ? undefined : inputs.get(inputGeneration);

    if (!input || inputGeneration !== generation || !active || signal.aborted) {
      return {
        error: "superseded",
        message: "This action was not accepted. Follow the latest user input.",
      };
    }

    try {
      const deadline = Date.now() + 4000;
      let guardTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          input.ready,
          new Promise<never>((_resolve, reject) => {
            guardTimer = setTimeout(
              () => reject(new Error("input_guard_timeout")),
              4000,
            );
          }),
        ]);
      } finally {
        clearTimeout(guardTimer);
      }

      while (!input.evidenceId && Date.now() < deadline) {
        if (!active || inputGeneration !== generation || signal.aborted) {
          return {
            error: "superseded",
            message: "This action was not accepted.",
          };
        }

        await delay(100);
      }

      if (
        !input.evidenceId ||
        !active ||
        inputGeneration !== generation ||
        signal.aborted
      ) {
        return {
          error: "input_not_confirmed",
          message:
            "The action was not accepted. Ask the user to repeat or finish the request.",
        };
      }

      const result = await toolService.execute(scope, claims.callId, {
        toolCallId,
        inputToken: input.token,
        generation: inputGeneration!,
        evidenceId: input.evidenceId,
        action,
      });

      void dispatchJobs().catch(() => report("outbox_dispatch_failed"));
      return result;
    } catch (error) {
      return {
        error:
          error instanceof VoiceToolError ? error.code : "action_unavailable",
        message: "The action was not accepted. Do not claim it succeeded.",
      };
    }
  };

  const journal = new TranscriptJournal({
    callId: claims.callId,
    append: async (input) => {
      const token = input.sourceEventId.split(":")[2];
      const inputGeneration = itemGenerations.get(token);
      const state =
        inputGeneration === undefined ? undefined : inputs.get(inputGeneration);

      await state?.ready.catch(() => {});
      return service.appendInput(scope, input, { queueTurn: false });
    },
    onFinal: async (evidenceId, inputGeneration) => {
      const input = inputs.get(inputGeneration);

      if (input) input.evidenceId = evidenceId;
    },
    onFailure: (code) => {
      report(code);

      if (code === "transcript_write_failed" || code === "transcript_limit") {
        // Stop taking more speech when we cannot preserve it. The text UI can retry.
        void finish().catch(() => report("call_cleanup_failed"));
      }
    },
  });

  async function finish(): Promise<void> {
    if (shutdown) {
      return shutdown;
    }

    active = false;
    generation += 1;
    clearInterval(lifecycleTimer);
    clearTimeout(durationTimer);

    // Stop accepting new microphone frames while finalizing frames already forwarded.
    session?.input.setAudioEnabled(false);

    shutdown = (async () => {
      // End lifecycle promptly, before any model generation or transcript grace wait.
      const endCall = service
        .endCall(scope, claims.callId, "disconnect")
        .then(() => dispatchJobs())
        .catch(() => report("call_end_or_dispatch_failed"));

      if (started && session) {
        try {
          await session.interrupt({ force: true });
        } catch {
          report("speech_interrupt_failed");
        }
      }

      if (inputAudioPending && model?.activeSession) {
        // Flush audio already received by the provider. This cannot recover unheard audio.
        await model.activeSession
          .commitAudio()
          .catch(() => report("audio_commit_failed"));
      }

      // Keep raw transcript handlers alive for late provider finals, even after hangup.
      await delay(FINAL_TRANSCRIPT_GRACE_MS);
      await session?.close().catch(() => report("voice_session_close_failed"));
      await journal.close();
      await endCall;

      await journal.settleTurns();
      await assistantWrites;
    })();

    return shutdown;
  }

  model = new JournaledRealtimeModel((raw) => {
    if (!raw || typeof raw !== "object") {
      return;
    }

    const event = raw as {
      type?: unknown;
      item_id?: unknown;
      response?: { id?: string };
      response_id?: string;
      item?: { type?: string; call_id?: string };
    };

    if (event.type === "response.created" && event.response?.id) {
      responseGenerations.set(event.response.id, committedGeneration);
    }

    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call" &&
      event.item.call_id &&
      event.response_id
    ) {
      const responseGeneration = responseGenerations.get(event.response_id);
      if (responseGeneration !== undefined)
        toolGenerations.set(event.item.call_id, responseGeneration);
    }

    if (event.type === "input_audio_buffer.speech_started") {
      generation += 1;
      inputAudioPending = true;

      if (typeof event.item_id === "string" && itemGenerations.size < 1000) {
        itemGenerations.set(event.item_id, generation);
        const inputGeneration = generation;
        const token = event.item_id;
        const expectedChatSequence = lastChatSequence;
        const ready = inputWrites.then(() =>
          toolService.beginInput(scope, claims.callId, {
            inputToken: token,
            generation: inputGeneration,
            expectedChatSequence,
          }),
        );

        inputWrites = ready.catch(() => report("voice_input_guard_failed"));
        inputs.set(inputGeneration, { token, ready });
      }
    }

    if (event.type === "input_audio_buffer.committed") {
      inputAudioPending = false;
      if (typeof event.item_id === "string") {
        committedGeneration = itemGenerations.get(event.item_id) ?? 0;
      }
    }

    const inputGeneration =
      typeof event.item_id === "string"
        ? (itemGenerations.get(event.item_id) ?? generation)
        : generation;

    journal.receive(raw, inputGeneration);
  });

  session = new voice.AgentSession({
    llm: model,
    turnHandling: {
      turnDetection: "realtime_llm",
      preemptiveGeneration: { enabled: false },
      interruption: { enabled: true },
    },
  });

  session.input.setAudioEnabled(false);

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (
      item.type !== "message" ||
      item.role !== "assistant" ||
      !item.textContent?.trim()
    )
      return;

    const response = { id: item.id, text: item.textContent };
    assistantWrites = assistantWrites
      .then(() => service.saveVoiceResponse(scope, claims.callId, response))
      .catch(() => {
        report("voice_response_write_failed");
        void finish().catch(() => report("call_cleanup_failed"));
      });
  });

  session.on(voice.AgentSessionEventTypes.Error, () =>
    report("voice_provider_error"),
  );
  session.on(voice.AgentSessionEventTypes.Close, () => {
    void finish()
      .catch(() => report("call_cleanup_failed"))
      .finally(() => ctx.shutdown("voice_session_closed"));
  });

  ctx.addShutdownCallback(finish);

  ctx.room.on("participantDisconnected", (participant) => {
    if (participant.identity === claims.participantIdentity) {
      void finish()
        .catch(() => report("call_cleanup_failed"))
        .finally(() => ctx.shutdown("caller_disconnected"));
    }
  });

  ctx.room.on("disconnected", () => {
    void finish()
      .catch(() => report("call_cleanup_failed"))
      .finally(() => ctx.shutdown("room_disconnected"));
  });

  try {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);

    if (ctx.room.name !== claims.roomName) {
      throw new Error("voice_room_mismatch");
    }

    let admissionTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        ctx.waitForParticipant(claims.participantIdentity),
        new Promise<never>((_resolve, reject) => {
          admissionTimer = setTimeout(
            () => reject(new Error("caller_join_timeout")),
            30_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(admissionTimer);
    }

    if (!active) {
      return;
    }

    await session.start({
      agent: new voice.Agent({
        instructions:
          voiceInstructions +
          "\nCurrent saved context: " +
          JSON.stringify(await currentContext()),
        tools: createVoiceTools(executeTool, currentContext),
        chatCtx,
      }),
      room: ctx.room,
      inputOptions: {
        participantIdentity: claims.participantIdentity,
        textEnabled: false,
        closeOnDisconnect: false,
        videoEnabled: false,
      },
      outputOptions: { transcriptionEnabled: false },
      record: false,
    });

    started = true;

    // An API-side end or newer chat must take effect even if the browser keeps RTC open.
    lifecycleTimer = setInterval(() => {
      if (polling || !active) {
        return;
      }

      polling = true;

      void (async () => {
        const [state] =
          await database`SELECT calls.status, conversations.last_chat_sequence
          FROM calls JOIN conversations ON conversations.id = calls.conversation_id
          WHERE calls.id = ${claims.callId} AND conversations.id = ${scope.conversationId}
            AND conversations.owner_id = ${scope.ownerId}`;

        if (!state || state.status !== "active") {
          await finish();
          ctx.shutdown("call_ended");
          return;
        }

        const chatSequence = Number(state.last_chat_sequence);

        if (chatSequence > lastChatSequence) {
          lastChatSequence = chatSequence;
          generation += 1;
          await session?.interrupt({ force: true });
          await session?.currentAgent?.updateChatCtx(
            await contextForCall(service, scope),
          );
          await session?.currentAgent?.updateInstructions(
            voiceInstructions +
              "\nCurrent saved context: " +
              JSON.stringify(await currentContext()),
          );
        }
      })()
        .catch(() => {
          report("call_state_check_failed");
          void finish()
            .catch(() => report("call_cleanup_failed"))
            .finally(() => ctx.shutdown("call_state_check_failed"));
        })
        .finally(() => {
          polling = false;
        });
    }, 2000);

    durationTimer = setTimeout(
      () => {
        void finish()
          .catch(() => report("call_cleanup_failed"))
          .finally(() => ctx.shutdown("call_duration_limit"));
      },
      15 * 60 * 1000,
    );

    await openCall({
      state: playbackState,
      uninterrupted: () => active,
      compose: async () => callGreetingInstructions,
      speak: (instructions) => {
        session!.input.setAudioEnabled(true);
        const greeting = session!.generateReply({
          instructions,
          toolChoice: "none",
          allowInterruptions: true,
        });
        void greeting
          .waitForPlayout()
          .catch(() => report("greeting_playout_failed"));
      },
      wait: () => delay(200),
    });
  } catch {
    report("call_start_failed");
    await finish();
    ctx.shutdown("call_start_failed");
  }
}

export default defineAgent({
  entry: async (ctx) => {
    try {
      await enterCall(ctx);
    } catch {
      report("call_admission_failed");
      ctx.shutdown("call_admission_failed");
    }
  },
});

// A worker job imports this file too; only the direct CLI invocation starts a server.
const workerPath = resolve("src/voice/worker.ts");

if (process.argv[1] && resolve(process.argv[1]) === workerPath) {
  if (process.argv.length === 2) {
    process.argv.push("dev");
  }

  cli.runApp(
    new ServerOptions({
      agent: workerPath,
      agentName: AGENT_NAME,
      logLevel: "warn",
      shutdownProcessTimeout: 15_000,
    }),
  );
}
