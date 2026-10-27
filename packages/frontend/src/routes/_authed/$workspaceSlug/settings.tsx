import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { User, Bell, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { NotificationSettings } from "@/features/notifications/components/notification-settings";
import { ProfileSettings } from "@/features/settings/components/profile-settings";
import { ApiKeySettings } from "@/features/settings/components/api-key-settings";

export const Route = createFileRoute("/_authed/$workspaceSlug/settings")({
  component: SettingsPage,
});

const tabs = [
  { id: "profile", label: "Profile", icon: User },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "api-keys", label: "API keys", icon: KeyRound },
] as const;

type TabId = (typeof tabs)[number]["id"];

function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("profile");

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

      <div className="border-b mt-6 mb-6">
        <nav className="flex gap-1 -mb-px">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
                  isActive
                    ? "border-foreground text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === "profile" && <ProfileSettings />}
      {activeTab === "notifications" && <NotificationSettings />}
      {activeTab === "api-keys" && <ApiKeySettings />}
    </div>
  );
}
