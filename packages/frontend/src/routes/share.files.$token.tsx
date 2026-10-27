import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { usePublicFileShare, useValidateFileShare } from "@/features/drive/api";
import { getFileIcon, formatFileSize } from "@/lib/file-icons";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Download, Lock, Share2 } from "lucide-react";

export const Route = createFileRoute("/share/files/$token")({
  component: ShareFilesPage,
});

function ShareFilesPage() {
  const { token } = Route.useParams();
  const { data, isLoading, isError } = usePublicFileShare(token);
  const validateShare = useValidateFileShare();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const publicShare = data?.data;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="animate-pulse space-y-4 w-full max-w-xl">
          <div className="h-8 w-64 bg-muted rounded" />
          <div className="h-4 w-48 bg-muted rounded" />
          <div className="h-48 w-full bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (isError || !publicShare) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Share not found</CardTitle>
            <CardDescription>
              This shared link doesn&apos;t exist, has been disabled, or has
              expired.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Password gate
  if (!publicShare.authorized) {
    const handleValidate = (e: React.FormEvent) => {
      e.preventDefault();
      setPasswordError("");
      validateShare.mutate(
        { token, password },
        {
          onSuccess: () => setPassword(""),
          onError: (error) => setPasswordError(error.message || "Unable to verify password"),
        },
      );
    };

    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle className="text-xl">Password required</CardTitle>
            <CardDescription>
              These files are protected. Enter the password to view them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleValidate} className="space-y-4">
              <Input
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={!password || validateShare.isPending}
              >
                {validateShare.isPending ? "Verifying..." : "View files"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Render shared files
  const { files, createdBy } = publicShare;
  const baseUrl = import.meta.env.VITE_API_BASE_URL || "/api";

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-2xl flex items-center gap-2 px-6 py-3">
          <Share2 className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Shared files</span>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-2xl px-6 py-8 space-y-6">
        {/* Info card */}
        <div className="flex items-center gap-3">
          <UserAvatar
            displayName={createdBy.displayName}
            avatarUrl={createdBy.avatarUrl}
            size="lg"
          />
          <div>
            <p className="text-sm font-medium">
              {createdBy.displayName} shared{" "}
              {files.length === 1 ? "a file" : `${files.length} files`} with you
            </p>
            <p className="text-xs text-muted-foreground">
              {new Date(publicShare.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>

        {/* File list */}
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {files.map(({ file }) => {
                const Icon = getFileIcon(file.mimeType, false);
                const downloadUrl = `${baseUrl}/public/files/${token}/${file.id}/download`;

                return (
                  <div
                    key={file.id}
                    className="flex items-center justify-between px-4 py-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-sm truncate">{file.name}</p>
                        {file.size != null && (
                          <p className="text-xs text-muted-foreground">
                            {formatFileSize(file.size)}
                          </p>
                        )}
                      </div>
                    </div>
                    <a
                      href={downloadUrl}
                      download
                      className="shrink-0"
                    >
                      <Button variant="outline" size="sm">
                        <Download className="h-4 w-4 mr-1" />
                        Download
                      </Button>
                    </a>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
