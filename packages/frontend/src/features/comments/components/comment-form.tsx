import { useState, useRef, useCallback } from "react";
import { stripDisallowedControlCharacters } from "@pm/shared";
import { useCreateComment } from "../api";
import { MentionDropdown, type MemberOption } from "./mention-dropdown";
import { useWorkspaceMembers } from "@/features/workspaces/api";
import { useParams } from "@tanstack/react-router";
import { useAuthStore } from "@/stores/auth-store";
import { Textarea } from "@/components/ui/textarea";

interface CommentFormProps {
  taskId: string;
}

export function CommentForm({ taskId }: CommentFormProps) {
  const [displayBody, setDisplayBody] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const createMutation = useCreateComment(taskId);

  const { workspaceSlug } = useParams({ strict: false }) as {
    workspaceSlug?: string;
  };
  const workspaces = useAuthStore((s) => s.workspaces);
  const membership = workspaceSlug
    ? workspaces.find((w) => w.workspace.slug === workspaceSlug)
    : undefined;
  const workspaceId = membership?.workspace.id || "";
  const { data: membersData } = useWorkspaceMembers(workspaceId);
  const members: MemberOption[] =
    membersData?.data?.map((m) => ({
      id: m.user.id,
      displayName: m.user.displayName,
      avatarUrl: m.user.avatarUrl,
    })) ?? [];

  // Map display name to user ID for building the stored body
  const mentionMapRef = useRef<Map<string, string>>(new Map());

  const buildStoredBody = useCallback(
    (display: string) => {
      let stored = display;
      for (const [name, userId] of mentionMapRef.current) {
        stored = stored.replaceAll(`@${name}`, `@[${userId}]`);
      }
      return stored;
    },
    [],
  );

  const handleSubmit = () => {
    const storedBody = stripDisallowedControlCharacters(buildStoredBody(displayBody)).trim();
    if (!storedBody) return;
    createMutation.mutate(
      { body: storedBody },
      {
        onSuccess: () => {
          setDisplayBody("");
          mentionMapRef.current.clear();
        },
      },
    );
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setDisplayBody(value);

    // Detect @ mentions
    const cursorPos = e.target.selectionStart;
    const textBefore = value.slice(0, cursorPos);
    const atIndex = textBefore.lastIndexOf("@");

    if (atIndex >= 0) {
      const charBefore = atIndex > 0 ? textBefore[atIndex - 1] : " ";
      const query = textBefore.slice(atIndex + 1);
      // Only trigger if @ is at start or preceded by whitespace, and no spaces in query
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
    // Replace @query with @DisplayName in the display text
    const before = displayBody.slice(0, mentionStart);
    const after = displayBody.slice(
      mentionStart + 1 + (mentionQuery?.length ?? 0),
    );
    const newDisplay = `${before}@${member.displayName} ${after}`;
    setDisplayBody(newDisplay);
    mentionMapRef.current.set(member.displayName, member.id);
    setMentionQuery(null);

    // Restore focus and cursor position
    const cursorPos = mentionStart + member.displayName.length + 2;
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursorPos, cursorPos);
    }, 0);
  };

  const filteredMembers = mentionQuery !== null
    ? members.filter((m) =>
        m.displayName.toLowerCase().includes(mentionQuery.toLowerCase()),
      )
    : [];

  // Clamp mentionIndex if the filtered list shrinks
  const clampedIndex = Math.min(mentionIndex, Math.max(filteredMembers.length - 1, 0));

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
        // The mention list is not a dialog layer. Stopping the key keeps the
        // task panel open; the next Escape still reaches it.
        e.stopPropagation();
        setMentionQuery(null);
        return;
      }
    }

    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          value={displayBody}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Write a comment... Use @ to mention"
          rows={3}
          className="resize-none"
        />
        {mentionQuery !== null && filteredMembers.length > 0 && (
          <MentionDropdown
            members={filteredMembers}
            onSelect={handleMentionSelect}
            selectedIndex={clampedIndex}
          />
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to
          post
        </span>
        <button
          onClick={handleSubmit}
          disabled={!stripDisallowedControlCharacters(displayBody).trim() || createMutation.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {createMutation.isPending ? "Posting..." : "Post"}
        </button>
      </div>
    </div>
  );
}
