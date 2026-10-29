import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Toaster, toast } from "sonner";
import { IdentityBoundary } from "@/components/providers/identity-boundary";
import { onIdentityChange } from "@/lib/identity";

// Notices about the previous account's work must not stay on screen.
onIdentityChange(({ previousUserId }) => {
  if (previousUserId) toast.dismiss();
});

export const Route = createRootRoute({
  component: RootComponent,
  errorComponent: RootErrorComponent,
});

function RootComponent() {
  return (
    <>
      <IdentityBoundary>
        <Outlet />
      </IdentityBoundary>
      <Toaster richColors position="top-right" />
    </>
  );
}

function RootErrorComponent({ error }: { error: Error }) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center space-y-3">
        <h1 className="text-2xl font-bold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    </div>
  );
}
