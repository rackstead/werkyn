import { cn } from "@/lib/utils";
import { useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { identityGeneration, subscribeIdentity } from "@/lib/identity";
import { isUploadedMediaUrl, UploadedMediaOwner } from "@/lib/uploaded-media";

interface UserAvatarProps {
  displayName: string;
  avatarUrl?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}

const sizeClasses = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
  xl: "h-20 w-20 text-2xl",
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function getColor(name: string): string {
  const colors = [
    "bg-blue-500", "bg-green-500", "bg-purple-500", "bg-orange-500",
    "bg-pink-500", "bg-teal-500", "bg-indigo-500", "bg-red-500",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

export function UserAvatar({ displayName, avatarUrl, size = "md", className }: UserAvatarProps) {
  const generation = useSyncExternalStore(subscribeIdentity, identityGeneration);
  const [resolved, setResolved] = useState<{ url: string; source: string; generation: number }>();
  const [error, setError] = useState("");
  const media = useMemo(() => new UploadedMediaOwner(setError), []);
  const uploaded = !!avatarUrl && isUploadedMediaUrl(avatarUrl);
  useLayoutEffect(() => { media.activate(); return () => media.dispose(); }, [media, generation]);
  useEffect(() => {
    let current = true;
    setResolved(undefined);
    setError("");
    media.reconcile(new Set(uploaded ? [avatarUrl!] : []));
    if (uploaded) void media.resolve(avatarUrl!).then(url => { if (current) setResolved({ url, source: avatarUrl!, generation }); }).catch(() => {});
    return () => { current = false; };
  }, [media, avatarUrl, uploaded, generation]);
  const src = uploaded ? resolved?.source === avatarUrl && resolved.generation === generation ? resolved.url : undefined : avatarUrl;
  if (src) {
    return (
      <img
        src={src}
        alt={displayName}
        className={cn(
          "rounded-full object-cover",
          sizeClasses[size],
          className,
        )}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full font-medium text-white",
        sizeClasses[size],
        getColor(displayName),
        className,
      )}
      role="img"
      aria-label={error ? `${displayName}: image unavailable` : displayName}
      title={error || undefined}
    >
      {getInitials(displayName)}
    </div>
  );
}
