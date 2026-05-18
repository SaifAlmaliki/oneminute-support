import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Mic } from "lucide-react";

export type ChatbotMode = "text" | "voice" | "both";

interface ModeConfigProps {
  mode: ChatbotMode;
  setMode: (m: ChatbotMode) => void;
}

const OPTIONS: { value: ChatbotMode; label: string; hint: string }[] = [
  { value: "text", label: "Text only", hint: "Visitors type to chat" },
  { value: "voice", label: "Voice only", hint: "Visitors talk to a voice agent" },
  { value: "both", label: "Text and voice", hint: "Visitors choose per session" },
];

const ModeConfig = ({ mode, setMode }: ModeConfigProps) => {
  return (
    <Card className="border-white/5 bg-[#0a0a0e]">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Mic className="w-4 h-4 text-zinc-500" />
          <CardTitle className="text-sm font-medium text-white uppercase tracking-wider">
            Conversation Mode
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-start gap-3 cursor-pointer p-3 rounded-md border border-white/5 hover:bg-white/4"
          >
            <input
              type="radio"
              name="chatbot-mode"
              value={opt.value}
              checked={mode === opt.value}
              onChange={() => setMode(opt.value)}
              className="mt-0.5"
            />
            <div>
              <Label className="text-zinc-200 text-sm">{opt.label}</Label>
              <p className="text-xs text-zinc-500 mt-0.5">{opt.hint}</p>
            </div>
          </label>
        ))}
      </CardContent>
    </Card>
  );
};

export default ModeConfig;
