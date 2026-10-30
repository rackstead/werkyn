import { useState, useRef, Suspense } from "react";
import { Smile } from "lucide-react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { lazyNamed } from "@/lib/lazy-import";
import { LoadingSpinner } from "@/components/shared/lazy-load";

// The emoji list is large, and the picker appears in the sidebar and dialogs of
// every workspace page, so its contents load when it is first opened (or when
// its trigger is hovered or focused).
const EmojiPickerContent = lazyNamed(
  () => import("./emoji-picker-content"),
  "EmojiPickerContent",
);

function LazyEmojiPickerContent(
  props: React.ComponentProps<typeof EmojiPickerContent>,
) {
  return (
    <Suspense
      fallback={
        <div className="flex h-[360px] w-[352px]">
          <LoadingSpinner label="Loading emoji…" />
        </div>
      }
    >
      <EmojiPickerContent {...props} />
    </Suspense>
  );
}

interface EmojiPickerProps {
  value: string | null;
  onChange: (emoji: string | null) => void;
  children?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function EmojiPicker({
  value,
  onChange,
  children,
  open: controlledOpen,
  onOpenChange,
}: EmojiPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = controlledOpen ?? internalOpen;
  const setOpen = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
  };
  const anchorRef = useRef<HTMLDivElement>(null);

  const handleSelect = (emoji: string) => {
    onChange(emoji);
    setOpen(false);
  };

  const handleRemove = () => {
    onChange(null);
    setOpen(false);
  };

  // Controlled mode (opened externally, e.g. from dropdown menu)
  if (isControlled) {
    return (
      <Popover open={open} onOpenChange={setOpen} modal>
        <PopoverAnchor asChild>
          <div ref={anchorRef} />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          side="right"
          className="w-auto p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <LazyEmojiPickerContent
            value={value}
            onSelect={handleSelect}
            onRemove={handleRemove}
          />
        </PopoverContent>
      </Popover>
    );
  }

  // Uncontrolled mode (has its own trigger)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onPointerEnter={EmojiPickerContent.preload}
        onFocus={EmojiPickerContent.preload}
      >
        {children ?? (
          <button
            type="button"
            className="flex items-center justify-center rounded-md hover:bg-accent transition-colors"
          >
            {value ? (
              <span className="text-3xl leading-none">{value}</span>
            ) : (
              <span className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                <Smile className="h-4 w-4" />
                Add icon
              </span>
            )}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <LazyEmojiPickerContent
          value={value}
          onSelect={handleSelect}
          onRemove={handleRemove}
        />
      </PopoverContent>
    </Popover>
  );
}
