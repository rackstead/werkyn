import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { usePublicWikiPage, useValidateWikiShare } from "@/features/wiki/api";
import { WikiEditor } from "@/features/wiki/components/wiki-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BookOpen, Lock } from "lucide-react";

export const Route = createFileRoute("/share/$token")({
  component: SharePage,
});

function SharePage() {
  const { token } = Route.useParams();
  const { data, isLoading, isError } = usePublicWikiPage(token);
  const validateShare = useValidateWikiShare();
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");

  const publicPage = data?.data;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="animate-pulse space-y-4 w-full max-w-3xl">
          <div className="h-8 w-64 bg-muted rounded" />
          <div className="h-4 w-48 bg-muted rounded" />
          <div className="h-64 w-full bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (isError || !publicPage) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Page not found</CardTitle>
            <CardDescription>
              This shared page doesn&apos;t exist or has been disabled.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  // Password gate
  if (!publicPage.authorized) {
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
              This page is protected. Enter the password to view it.
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
                {validateShare.isPending ? "Verifying..." : "View page"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Render shared page
  const { page } = publicPage;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto max-w-3xl flex items-center gap-2 px-6 py-3">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Shared page</span>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-3xl px-6 py-8">
        {page.icon && (
          <div className="text-4xl mb-2">{page.icon}</div>
        )}
        <h1 className="text-3xl font-bold mb-2">{page.title}</h1>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-8">
          {page.lastEditedBy && (
            <span>By {page.lastEditedBy.displayName}</span>
          )}
          <span>
            {new Date(page.updatedAt).toLocaleDateString()}
          </span>
        </div>

        <WikiEditor
          initialContent={page.content}
          readOnly
        />
      </main>
    </div>
  );
}
