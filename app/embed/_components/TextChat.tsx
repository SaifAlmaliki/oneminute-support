"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Send } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React, { useEffect, useRef, useState } from "react";

interface Section {
  id: string;
  name: string;
  source_ids: string[];
}

interface TextChatProps {
  token: string;
  primaryColor: string;
  welcomeMessage: string;
  sections: Section[];
}

const TextChat = ({ token, primaryColor, welcomeMessage, sections }: TextChatProps) => {
  const [messages, setMessages] = useState<any[]>([
    { role: "assistant", content: welcomeMessage, isWelcome: true, section: null },
  ]);
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isTyping]);

  const handleSend = async () => {
    if (!input.trim()) return;
    const currentSection = sections.find((s) => s.name === activeSection);
    const sourceIds = currentSection?.source_ids || [];
    const userMsg = { role: "user", content: input, section: activeSection };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    try {
      const res = await fetch("/api/chat/public", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [...messages, userMsg], knowledge_source_ids: sourceIds }),
      });
      if (res.ok) {
        const data = await res.json();
        setMessages((prev) => [...prev, { role: "assistant", content: data.response, section: null }]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "I'm having trouble connecting right now. Please try again.", section: null },
        ]);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsTyping(false);
    }
  };

  const handleSectionClick = (sectionName: string) => {
    setActiveSection(sectionName);
    const userMsg = { role: "user", content: sectionName, section: null };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsTyping(true);
    setTimeout(() => {
      setIsTyping(false);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `You can ask me any question related to "${sectionName}"`, section: sectionName },
      ]);
    }, 800);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-950/30 p-4 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        <div className="space-y-6 pb-4">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn("flex w-full flex-col", msg.role === "user" ? "items-end" : "items-start")}
            >
              <div className={cn("flex max-w-[85%] gap-3", msg.role === "user" ? "flex-row-reverse" : "flex-row")}>
                {msg.role !== "user" && (
                  <div className="w-9 h-9 relative rounded-full flex items-center justify-center shrink-0 border border-white/5">
                    <Image
                      src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                      alt="Support Agent"
                      width={50}
                      height={50}
                      className="w-full h-full rounded-full object-cover"
                    />
                    <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-[#0E0E12] rounded-full" />
                  </div>
                )}
                <div className="space-y-2">
                  <div
                    className={cn(
                      "p-3.5 rounded-2xl text-sm leading-relaxed shadow-sm",
                      msg.role === "user"
                        ? "bg-zinc-800 text-zinc-100 rounded-tr-sm"
                        : "bg-white text-zinc-900 rounded-tl-sm"
                    )}
                  >
                    {msg.content}
                  </div>
                  {msg.isWelcome && sections.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-1 ml-1 animate-in fade-in slide-in-from-top-1 duration-300">
                      {sections.map((section) => (
                        <button
                          key={section.id}
                          onClick={() => handleSectionClick(section.name)}
                          className="px-3 py-1.5 rounded-full border border-zinc-700 bg-zinc-800/50 hover:bg-zinc-700 hover:border-zinc-600 text-zinc-300 text-xs font-medium transition-all"
                        >
                          {section.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          {isTyping && (
            <div className="flex w-full justify-start">
              <div className="flex max-w-[85%] gap-3 flex-row">
                <div className="w-9 h-9 relative rounded-full flex items-center justify-center shrink-0 border border-white/5">
                  <Image
                    src="https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=64&h=64&q=80&fit=crop"
                    alt="Support Agent"
                    width={50}
                    height={50}
                    className="w-full h-full rounded-full object-cover"
                  />
                  <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 border-2 border-[#0E0E12] rounded-full" />
                </div>
                <div className="p-4 rounded-2xl bg-white text-zinc-900 rounded-tl-sm shadow-sm flex items-center gap-1">
                  <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
                  <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
                  <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-bounce" />
                </div>
              </div>
            </div>
          )}
          <div ref={scrollRef} />
        </div>
      </div>

      <div className="p-4 bg-[#0a0a0e] border-t border-white/5 shrink-0 z-20">
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!activeSection}
            placeholder={activeSection ? "Type a message..." : "Select a topic above..."}
            className="min-h-12.5 max-h-30 pr-12 outline-none text-white bg-zinc-900/50 border-white/10 resize-none rounded-xl disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-zinc-600 focus:ring-1 focus:ring-white/20"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!activeSection || !input.trim()}
            className={cn(
              "absolute right-2 bottom-2 h-8 w-8 transition-colors shadow-sm",
              !activeSection || !input.trim() ? "bg-zinc-800 text-zinc-500" : ""
            )}
            style={
              activeSection && input.trim()
                ? { backgroundColor: primaryColor, color: "white" }
                : {}
            }
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
        <div className="mt-2 text-center">
          <Link href={"/"} className="text-[10px] text-zinc-600 font-medium hover:text-zinc-500 transition-colors">
            Powered by OneMinute Support
          </Link>
        </div>
      </div>
    </>
  );
};

export default TextChat;
