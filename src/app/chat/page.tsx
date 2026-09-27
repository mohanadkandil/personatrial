import { ChatExperience } from "@/components/chat-experience";
import { LiveChatExperience } from "@/components/live-chat-experience";

export const dynamic = "force-dynamic";

export default function ChatPage() {
  return process.env.PERSONA_BACKEND_ENABLED === "1" ? (
    <LiveChatExperience />
  ) : (
    <ChatExperience />
  );
}
