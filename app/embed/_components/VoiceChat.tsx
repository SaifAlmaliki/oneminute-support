"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Conversation } from "@elevenlabs/client";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

interface Section {
  id: string;
  name: string;
  source_ids: string[];
}

interface VoiceChatProps {
  token: string;
  primaryColor: string;
  welcomeMessage: string;
  sections: Section[];
}

type Phase = "idle" | "connecting" | "live" | "error";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

type ElConversation = Awaited<ReturnType<typeof Conversation.startSession>>;

const VoiceChat = ({ token, primaryColor, welcomeMessage, sections }: VoiceChatProps) => {
  const [activeSection, setActiveSection] = useState<Section | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [transcript, setTranscript] = useState<Turn[]>([
    { role: "assistant", content: welcomeMessage },
  ]);

  const conversationRef = useRef<ElConversation | null>(null);
  const voiceTokenRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, phase]);

  const persistTurn = async (turn: Turn) => {
    const vt = voiceTokenRef.current;
    if (!vt) return;
    try {
      await fetch("/api/widget/voice-transcript", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${vt}`,
        },
        body: JSON.stringify(turn),
      });
    } catch (e) {
      console.error("voice-transcript persist failed", e);
    }
  };

  const handleStart = async () => {
    if (!activeSection) return;
    setPhase("connecting");
    setErrorMessage("");

    try {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setErrorMessage("Please allow microphone access to start a voice call.");
        setPhase("error");
        return;
      }

      const res = await fetch("/api/widget/voice-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ section_id: activeSection.id }),
      });
      if (!res.ok) {
        setErrorMessage("Couldn't reach the voice service. Please try again.");
        setPhase("error");
        return;
      }
      const { signed_url, voice_token } = await res.json();
      voiceTokenRef.current = voice_token;

      const convo = await Conversation.startSession({
        signedUrl: signed_url,
        dynamicVariables: { voice_token },
        onConnect: () => setPhase("live"),
        onDisconnect: () => {
          setPhase("idle");
          setAgentSpeaking(false);
        },
        onError: (message) => {
          console.error("EL convo error:", message);
          setErrorMessage("Connection lost.");
          setPhase("error");
        },
        onModeChange: ({ mode }) => setAgentSpeaking(mode === "speaking"),
        onMessage: ({ message, role }) => {
          if (!message) return;
          const ourRole: "user" | "assistant" = role === "user" ? "user" : "assistant";
          const turn: Turn = { role: ourRole, content: message };
          setTranscript((prev) => [...prev, turn]);
          persistTurn(turn);
        },
      });
      conversationRef.current = convo;
    } catch (e) {
      console.error("voice start failed:", e);
      setErrorMessage("Couldn't reach the voice service. Please try again.");
      setPhase("error");
    }
  };

  const handleHangup = async () => {
    try {
      await conversationRef.current?.endSession();
    } finally {
      conversationRef.current = null;
      voiceTokenRef.current = null;
      setPhase("idle");
      setAgentSpeaking(false);
    }
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-950/30 p-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        <div className="space-y-6 pb-4">
          {transcript.map((t, i) => (
            <div
              key={i}
              className={cn("flex w-full flex-col", t.role === "user" ? "items-end" : "items-start")}
            >
              <div className={cn("flex max-w-[85%] gap-3", t.role === "user" ? "flex-row-reverse" : "flex-row")}>
                {t.role !== "user" && (
                  <div className="w-9 h-9 relative rounded-full flex items-center justify-center shrink-0 border border-white/5">
                    <Image
                      src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                      alt="Support Agent"
                      width={50}
                      height={50}
                      className="w-full h-full rounded-full object-cover"
                    />
                  </div>
                )}
                <div
                  className={cn(
                    "p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm",
                    t.role === "user"
                      ? "bg-zinc-800 text-zinc-100 rounded-tr-sm"
                      : "bg-white text-zinc-900 rounded-tl-sm"
                  )}
                >
                  {t.content}
                </div>
              </div>
            </div>
          ))}

          {phase === "idle" && !activeSection && sections.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1 ml-1 animate-in fade-in slide-in-from-top-1 duration-300">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section)}
                  className="px-3 py-1.5 rounded-full border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-700 hover:border-zinc-600 text-zinc-300 text-xs font-medium transition-all"
                >
                  {section.name}
                </button>
              ))}
            </div>
          )}

          {phase === "error" && (
            <div className="bg-red-950/30 border border-red-900/50 text-red-300 text-xs p-3 rounded-md">
              {errorMessage}
            </div>
          )}

          <div ref={scrollRef} />
        </div>
      </div>

      <div className="p-6 bg-[#0a0a0e] border-t border-white/5 shrink-0 z-20 flex flex-col items-center gap-3">
        {phase === "live" ? (
          <>
            <div
              className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center transition-all",
                agentSpeaking ? "animate-pulse" : ""
              )}
              style={{ backgroundColor: primaryColor }}
            >
              <Mic className="w-7 h-7 text-white" />
            </div>
            <span className="text-xs text-zinc-400">
              {agentSpeaking ? "Speaking…" : "Listening…"}
            </span>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleHangup}
              className="bg-red-600 hover:bg-red-700"
            >
              <PhoneOff className="w-4 h-4 mr-2" />
              Hang up
            </Button>
          </>
        ) : (
          <>
            <button
              onClick={handleStart}
              disabled={!activeSection || phase === "connecting"}
              className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed",
                phase === "connecting" ? "animate-pulse" : "hover:brightness-110"
              )}
              style={{ backgroundColor: activeSection ? primaryColor : "#3f3f46" }}
              aria-label="Start voice call"
            >
              {activeSection ? (
                <Mic className="w-7 h-7 text-white" />
              ) : (
                <MicOff className="w-7 h-7 text-zinc-300" />
              )}
            </button>
            <span className="text-xs text-zinc-500">
              {phase === "connecting"
                ? "Connecting…"
                : activeSection
                ? `Talk · ${activeSection.name}`
                : "Select a topic above"}
            </span>
          </>
        )}
        <Link
          href={"/"}
          className="text-[10px] text-zinc-600 font-medium hover:text-zinc-500 transition-colors"
        >
          Powered by OneMinute Support
        </Link>
      </div>
    </>
  );
};

export default VoiceChat;
