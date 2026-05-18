"use client";

import ModeToggle from "@/app/embed/_components/ModeToggle";
import TextChat from "@/app/embed/_components/TextChat";
import VoiceChat from "@/app/embed/_components/VoiceChat";
import {
  AlertCircle,
  ChevronDown,
  MessageCircle,
} from "lucide-react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import React, { useEffect, useState } from "react";

interface ChatBotMetadata {
  id: string;
  color: string;
  welcome_message: string;
  mode: "text" | "voice" | "both";
}

interface Section {
  id: string;
  name: string;
  source_ids: string[];
}

const EmbedPage = () => {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [metadata, setMetadata] = useState<ChatBotMetadata | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [activeMode, setActiveMode] = useState<"text" | "voice">("text");

  useEffect(() => {
    document.body.style.backgroundColor = "transparent";
    document.documentElement.style.backgroundColor = "transparent";
    if (typeof window !== undefined) {
      window.parent.postMessage(
        { type: "resize", width: "60px", height: "60px", borderRadius: "30px" },
        "*"
      );
    }
  }, []);

  const toggleOpen = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    window.parent.postMessage(
      newState
        ? { type: "resize", width: "380px", height: "520px", borderRadius: "12px" }
        : { type: "resize", width: "60px", height: "60px", borderRadius: "30px" },
      "*"
    );
  };

  useEffect(() => {
    if (!metadata) return;
    if (metadata.mode === "voice") setActiveMode("voice");
    else setActiveMode("text");
  }, [metadata?.mode]);

  useEffect(() => {
    if (!token) {
      setError("Missing session token");
      setLoading(false);
      return;
    }
    const fetchConfig = async () => {
      try {
        const res = await fetch(`/api/widget/config?token=${token}`);
        if (!res.ok) throw new Error("Failed to load widget configuration");
        const data = await res.json();
        setMetadata(data.metadata);
        setSections(data.sections || []);
      } catch (err) {
        console.error(err);
        setError("Unable to load chat. Please try again later.");
      } finally {
        setLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const primaryColor = metadata?.color || "#4f46e5";

  if (loading) return null;
  if (error && isOpen) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-[#0A0A0E] text-red-400 p-6 text-center rounded-xl border border-white/10">
        <AlertCircle className="w-10 h-10 mb-2" />
        <p>{error}</p>
      </div>
    );
  }
  if (!isOpen) {
    return (
      <button
        onClick={toggleOpen}
        className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg hover:brightness-110 transition-all text-white"
        style={{ backgroundColor: primaryColor }}
      >
        <MessageCircle className="w-8 h-8" />
      </button>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#0A0A0E] overflow-hidden rounded-xl border border-white/10 shadow-2xl">
      <div className="h-14 border-b border-white/5 flex items-center justify-between px-4 bg-[#0E0E12] shadow-sm shrink-0 z-20">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border border-white/5 overflow-hidden">
              <Image
                src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                alt="Support Agent"
                width={40}
                height={40}
                className="w-full h-full object-cover"
              />
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-[#0E0E12] rounded-full" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white leading-none">Support</h1>
            <span className="text-[11px] text-emerald-400 font-medium">Online</span>
          </div>
        </div>
        <button
          onClick={toggleOpen}
          className="p-2 text-zinc-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
          aria-label="Minimize Chat"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      </div>

      {token && metadata && (
        <>
          {metadata.mode === "both" && (
            <ModeToggle
              active={activeMode}
              onChange={setActiveMode}
              primaryColor={primaryColor}
            />
          )}
          {activeMode === "voice" && (metadata.mode === "voice" || metadata.mode === "both") ? (
            <VoiceChat
              key="voice"
              token={token}
              primaryColor={primaryColor}
              welcomeMessage={metadata.welcome_message || "Hi! How can I help you?"}
              sections={sections}
            />
          ) : (
            <TextChat
              key="text"
              token={token}
              primaryColor={primaryColor}
              welcomeMessage={metadata.welcome_message || "Hi! How can I help you?"}
              sections={sections}
            />
          )}
        </>
      )}
    </div>
  );
};

export default EmbedPage;
