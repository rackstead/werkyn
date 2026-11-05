import { cn } from "@/lib/utils";

interface LoadMoreButtonProps {
  onClick: () => void;
  loading?: boolean;
  label?: string;
  className?: string;
}

/** The "load the next page" control used by paged lists. */
export function LoadMoreButton({
  onClick,
  loading = false,
  label = "Load more",
  className,
}: LoadMoreButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={cn(
        "text-xs text-primary hover:underline disabled:opacity-50",
        className,
      )}
    >
      {loading ? "Loading..." : label}
    </button>
  );
}
