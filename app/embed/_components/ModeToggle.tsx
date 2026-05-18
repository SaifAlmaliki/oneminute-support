"use client";

import { cn } from "@/lib/utils";
import { MessageCircle, Mic } from "lucide-react";

interface ModeToggleProps {
  active: "text" | "voice";
  onChange: (m: "text" | "voice") => void;
  primaryColor: string;
}

const ModeToggle = ({ active, onChange, primaryColor }: ModeToggleProps) => {
  return (
    <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border-b border-white/5">
      <button
        onClick={() => onChange("text")}
        className={cn(
          "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs rounded-md transition-colors",
          active === "text" ? "text-white" : "text-zinc-500 hover:text-zinc-300"
        )}
        style={active === "text" ? { backgroundColor: primaryColor } : undefined}
      >
        <MessageCircle className="w-3.5 h-3.5" />
        Chat
      </button>
      <button
        onClick={() => onChange("voice")}
        className={cn(
          "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs rounded-md transition-colors",
          active === "voice" ? "text-white" : "text-zinc-500 hover:text-zinc-300"
        )}
        style={active === "voice" ? { backgroundColor: primaryColor } : undefined}
      >
        <Mic className="w-3.5 h-3.5" />
        Talk
      </button>
    </div>
  );
};

export default ModeToggle;
