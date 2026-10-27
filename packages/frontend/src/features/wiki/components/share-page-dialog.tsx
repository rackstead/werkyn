import { useState, useEffect } from "react";
import {
  useWikiPageShare,
  useCreateWikiShare,
  useUpdateWikiShare,
  useDeleteWikiShare,
} from "../api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Check, Copy, ExternalLink, Trash2 } from "lucide-react";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { toast } from "sonner";

interface SharePageDialogProps {
  open: boolean;
  onClose: () => void;
  pageId: string;
}

export function SharePageDialog({
  open,
  onClose,
  pageId,
}: SharePageDialogProps) {
  const { data: shareData, isLoading } = useWikiPageShare(open ? pageId : undefined);
  const createShare = useCreateWikiShare(pageId);
  const updateShare = useUpdateWikiShare(pageId);
  const deleteShare = useDeleteWikiShare(pageId);

  const [password, setPassword] = useState("");
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [copied, setCopied] = useState(false);

  const share = shareData?.data;

  useEffect(() => {
    if (open) {
      setPassword("");
      setShowPasswordField(false);
      setCopied(false);
    }
  }, [open]);

  const shareUrl = share
    ? `${window.location.origin}/share/${share.token}`
    : "";

  const handleCreate = () => {
    createShare.mutate({
      ...(password.trim() && { password: password.trim() }),
    });
  };

  const handleCopyLink = () => {
    copyToClipboard(shareUrl);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleEnabled = () => {
    if (!share) return;
    updateShare.mutate({
      shid: share.id,
      enabled: !share.enabled,
    });
  };

  const handleSetPassword = () => {
    if (!share) return;
    updateShare.mutate(
      {
        shid: share.id,
        password: password.trim() || null,
      },
      {
        onSuccess: () => {
          setPassword("");
          setShowPasswordField(false);
          toast.success(
            password.trim() ? "Password set" : "Password removed",
          );
        },
      },
    );
  };

  const handleDelete = () => {
    if (!share) return;
    deleteShare.mutate(share.id, {
      onSuccess: () => onClose(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share page</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading...
          </div>
        ) : !share ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Create a public link to share this page with anyone. They
              won&apos;t need to sign in.
            </p>

            <div className="space-y-2">
              <Label htmlFor="share-password">
                Password protection (optional)
              </Label>
              <Input
                id="share-password"
                type="password"
                placeholder="Leave empty for no password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                disabled={createShare.isPending}
              >
                {createShare.isPending ? "Creating..." : "Create link"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {/* Link + copy */}
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={shareUrl}
                className="text-xs font-mono"
              />
              <Button
                size="icon"
                variant="outline"
                onClick={handleCopyLink}
                title="Copy link"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="icon"
                variant="outline"
                onClick={() => window.open(shareUrl, "_blank")}
                title="Open in new tab"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
            </div>

            {/* Toggle enabled */}
            <div className="flex items-center justify-between">
              <Label>Sharing enabled</Label>
              <Button
                size="sm"
                variant={share.enabled ? "default" : "outline"}
                onClick={handleToggleEnabled}
                disabled={updateShare.isPending}
              >
                {share.enabled ? "Enabled" : "Disabled"}
              </Button>
            </div>

            {/* Password */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>
                  Password {share.hasPassword ? "(set)" : "(none)"}
                </Label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowPasswordField(!showPasswordField)}
                >
                  {showPasswordField ? "Cancel" : "Change"}
                </Button>
              </div>
              {showPasswordField && (
                <div className="flex items-center gap-2">
                  <Input
                    type="password"
                    placeholder="New password (empty to remove)"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <Button
                    size="sm"
                    onClick={handleSetPassword}
                    disabled={updateShare.isPending}
                  >
                    Save
                  </Button>
                </div>
              )}
            </div>

            {/* Delete share */}
            <div className="border-t pt-4">
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDelete}
                disabled={deleteShare.isPending}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {deleteShare.isPending ? "Removing..." : "Remove share link"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
