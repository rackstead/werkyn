import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendHorizontal } from "lucide-react";
import { usePendingSend } from "./use-pending-send";

interface MessageInputProps {
  /** A returned promise keeps the draft until it resolves; on rejection the draft stays for a retry. */
  onSend: (content: string) => void | Promise<unknown>;
  onTyping?: () => void;
  placeholder?: string;
  disabled?: boolean;
}

export function MessageInput({
  onSend,
  onTyping,
  placeholder = "Type a message...",
  disabled,
}: MessageInputProps) {
  const [content, setContent] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { sending, run } = usePendingSend(textareaRef, disabled);

  const handleSubmit = useCallback(() => {
    const trimmed = content.trim();
    if (!trimmed) return;
    run(
      () => onSend(trimmed),
      () => setContent(""),
    );
  }, [content, onSend, run]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    onTyping?.();
  };

  return (
    <div className="flex items-center gap-2 border-t p-4">
      <Textarea
        ref={textareaRef}
        value={content}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled || sending}
        className="min-h-[40px] max-h-32 resize-none"
        rows={1}
      />
      <Button
        size="icon"
        className="shrink-0"
        onClick={handleSubmit}
        disabled={!content.trim() || disabled || sending}
      >
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
