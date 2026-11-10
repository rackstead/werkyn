import { useAuthStore } from "@/stores/auth-store";
import { useUIStore } from "@/stores/ui-store";
import { UserAvatar } from "@/components/shared/user-avatar";
import { useState, useRef, useEffect } from "react";
import { AvatarCropDialog, preloadAvatarCropDialog } from "@/components/shared/avatar-crop-dialog.lazy";
import {
  AVATAR_ACCEPT,
  avatarFileProblem,
} from "@/components/shared/avatar-crop";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PanelLeft, LogOut, Search, Camera, Settings, Shield } from "lucide-react";
import { SearchCommand } from "@/features/search/components/search-command";
import { NotificationBell } from "@/features/notifications/components/notification-bell";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUploadFile } from "@/features/uploads/api";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

export function Topbar() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const workspaces = useAuthStore((s) => s.workspaces);
  const collapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggle = useUIStore((s) => s.toggleSidebar);
  const navigate = useNavigate();

  const { workspaceSlug } = useParams({ strict: false }) as {
    workspaceSlug?: string;
  };

  const membership = workspaceSlug
    ? workspaces.find((w) => w.workspace.slug === workspaceSlug)
    : undefined;
  const workspaceId = membership?.workspace.id;

  const [searchOpen, setSearchOpen] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarWorkspaceId, setAvatarWorkspaceId] = useState<string | null>(null);
  const [avatarSaving, setAvatarSaving] = useState(false);
  const avatarSavingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadFile = useUploadFile();

  // Cmd+K / Ctrl+K keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!avatarFile || avatarSavingRef.current) return;
    if (avatarWorkspaceId !== workspaceId) {
      setAvatarFile(null);
      setAvatarWorkspaceId(null);
    }
  }, [workspaceId, avatarFile, avatarWorkspaceId, avatarSaving]);

  const handleLogout = () => {
    // Local state is cleared at once; server revocation finishes on its own.
    void logout();
    navigate({ to: "/login" });
  };

  const chooseAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !workspaceId) return;
    const problem = avatarFileProblem(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setAvatarFile(file);
    setAvatarWorkspaceId(workspaceId);
  };

  const dismissAvatar = () => {
    if (avatarSavingRef.current) return;
    setAvatarFile(null);
    setAvatarWorkspaceId(null);
  };

  const saveAvatar = async (cropped: File) => {
    const targetWorkspaceId = avatarWorkspaceId;
    if (avatarSavingRef.current || !targetWorkspaceId) return;
    avatarSavingRef.current = true;
    setAvatarSaving(true);
    try {
      const result = await uploadFile.mutateAsync({
        file: cropped,
        purpose: "avatar",
        workspaceId: targetWorkspaceId,
      });
      const res = await api
        .patch("users/me", {
          json: { avatarUrl: result.data.url },
          // The upload belongs to this account; never apply it to another.
          context: user ? { expectedUserId: user.id } : {},
        })
        .json<{ data: { id: string; avatarUrl: string } }>();
      const currentUser = useAuthStore.getState().user;
      if (currentUser?.id === res.data.id) {
        useAuthStore.setState({
          user: { ...currentUser, avatarUrl: res.data.avatarUrl },
        });
      }
      toast.success("Avatar updated");
      setAvatarFile(null);
      setAvatarWorkspaceId(null);
    } catch {
      // Only the account that chose the picture hears that it failed.
      if (useAuthStore.getState().user?.id === user?.id)
        toast.error("Failed to upload avatar");
    } finally {
      avatarSavingRef.current = false;
      setAvatarSaving(false);
    }
  };

  return (
    <header className="flex h-12 items-center border-b bg-background px-4 gap-2">
      {collapsed && (
        <button
          onClick={toggle}
          className="rounded-md p-1.5 hover:bg-accent transition-colors"
          aria-label="Open sidebar"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}

      <button
        onClick={() => setSearchOpen(true)}
        className="flex items-center gap-2 rounded-md border px-3 py-1 text-sm text-muted-foreground hover:bg-accent transition-colors"
        aria-label="Search (Cmd+K)"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search...</span>
        <kbd className="hidden sm:inline-flex ml-2 rounded border bg-muted px-1 text-[10px]">
          {"\u2318"}K
        </kbd>
      </button>

      <div className="flex-1" />

      <ThemeToggle />

      <NotificationBell />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-full hover:ring-2 hover:ring-accent transition-all">
            {user && (
              <UserAvatar
                displayName={user.displayName}
                avatarUrl={user.avatarUrl}
                size="sm"
              />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col">
              <p className="text-sm font-medium">{user?.displayName}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onPointerEnter={preloadAvatarCropDialog}
            onFocus={preloadAvatarCropDialog}
            onClick={() => {
              preloadAvatarCropDialog();
              fileInputRef.current?.click();
            }}
          >
            <Camera className="h-4 w-4" />
            Change avatar
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              if (workspaceSlug) {
                navigate({
                  to: "/$workspaceSlug/settings",
                  params: { workspaceSlug },
                });
              }
            }}
          >
            <Settings className="h-4 w-4" />
            Settings
          </DropdownMenuItem>
          {membership?.role === "ADMIN" && workspaceSlug && (
            <DropdownMenuItem
              onClick={() => {
                navigate({
                  to: "/$workspaceSlug/admin",
                  params: { workspaceSlug },
                });
              }}
            >
              <Shield className="h-4 w-4" />
              Admin
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={handleLogout}
            className="text-destructive focus:text-destructive"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept={AVATAR_ACCEPT}
        className="hidden"
        onChange={chooseAvatar}
      />

      {avatarFile && (
        <AvatarCropDialog
          file={avatarFile}
          saving={avatarSaving}
          onCancel={dismissAvatar}
          onConfirm={saveAvatar}
          onError={(message) => toast.error(message)}
        />
      )}

      {workspaceId && workspaceSlug && (
        <SearchCommand
          open={searchOpen}
          onOpenChange={setSearchOpen}
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
        />
      )}
    </header>
  );
}
