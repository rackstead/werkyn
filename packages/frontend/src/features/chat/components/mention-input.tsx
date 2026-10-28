import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SendHorizontal } from "lucide-react";
import { MentionDropdown, type MemberOption } from "@/features/comments/components/mention-dropdown";
import { usePendingSend } from "./use-pending-send";

interface MentionInputProps {
  /** A returned promise keeps the draft until it resolves; on rejection the draft stays for a retry. */
  onSend: (content: string) => void | Promise<unknown>;
  onTyping?: () => void;
  members: MemberOption[];
  placeholder?: string;
  disabled?: boolean;
}

export function MentionInput({
  onSend,
  onTyping,
  members,
  placeholder = "Type a message... Use @ to mention",
  disabled,
}: MentionInputProps) {
  const [displayContent, setDisplayContent] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionMapRef = useRef<Map<string, string>>(new Map());
  const { sending, run } = usePendingSend(textareaRef, disabled);

  const buildStoredContent = useCallback((display: string) => {
    let stored = display;
    for (const [name, userId] of mentionMapRef.current) {
      stored = stored.replaceAll(`@${name}`, `@[${userId}]`);
    }
    return stored;
  }, []);

  const handleSubmit = useCallback(() => {
    const stored = buildStoredContent(displayContent).trim();
    if (!stored) return;
    run(
      () => onSend(stored),
      () => {
        setDisplayContent("");
        mentionMapRef.current.clear();
      },
    );
  }, [displayContent, onSend, buildStoredContent, run]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDisplayContent(value);
    onTyping?.();

    const cursorPos = e.target.selectionStart;
    const textBefore = value.slice(0, cursorPos);
    const atIndex = textBefore.lastIndexOf("@");

    if (atIndex >= 0) {
      const charBefore = atIndex > 0 ? textBefore[atIndex - 1] : " ";
      const query = textBefore.slice(atIndex + 1);
      if (
        (charBefore === " " || charBefore === "\n" || atIndex === 0) &&
        !query.includes(" ") &&
        !query.includes("\n")
      ) {
        setMentionQuery(query);
        setMentionStart(atIndex);
        setMentionIndex(0);
        return;
      }
    }
    setMentionQuery(null);
  };

  const handleMentionSelect = (member: MemberOption) => {
    const before = displayContent.slice(0, mentionStart);
    const after = displayContent.slice(
      mentionStart + 1 + (mentionQuery?.length ?? 0),
    );
    const newDisplay = `${before}@${member.displayName} ${after}`;
    setDisplayContent(newDisplay);
    mentionMapRef.current.set(member.displayName, member.id);
    setMentionQuery(null);

    const cursorPos = mentionStart + member.displayName.length + 2;
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursorPos, cursorPos);
    }, 0);
  };

  const filteredMembers =
    mentionQuery !== null
      ? members.filter((m) =>
          m.displayName.toLowerCase().includes(mentionQuery.toLowerCase()),
        )
      : [];

  const clampedIndex = Math.min(
    mentionIndex,
    Math.max(filteredMembers.length - 1, 0),
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && filteredMembers.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(i + 1, filteredMembers.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        handleMentionSelect(filteredMembers[clampedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex items-center gap-2 border-t p-4">
      <div className="relative flex-1">
        <Textarea
          ref={textareaRef}
          value={displayContent}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || sending}
          className="min-h-[40px] max-h-32 resize-none"
          rows={1}
        />
        {mentionQuery !== null && filteredMembers.length > 0 && (
          <MentionDropdown
            members={filteredMembers}
            onSelect={handleMentionSelect}
            selectedIndex={clampedIndex}
          />
        )}
      </div>
      <Button
        size="icon"
        className="shrink-0"
        onClick={handleSubmit}
        disabled={!displayContent.trim() || disabled || sending}
      >
        <SendHorizontal className="h-4 w-4" />
      </Button>
    </div>
  );
}
