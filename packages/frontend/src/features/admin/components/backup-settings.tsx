import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  Download,
  Upload,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { useProjects } from "@/features/projects/api";
import { useChannels, type ChatChannel } from "@/features/chat/api";
import { useWikiSpaces } from "@/features/wiki/api";
import { useExportBackup, usePreviewRestore, useExecuteRestore } from "../backup-api";
import type { BackupExportRequest, RestoreSummary } from "@pm/shared";
import { BackupScopeNotice } from "./backup-scope-notice";

interface BackupSettingsProps {
  workspaceId: string;
}

// ─── Project Selection Item ─────────────────────────────

interface ProjectOption {
  projectId: string;
  name: string;
  includeTasks: boolean;
  includeComments: boolean;
  includeLabels: boolean;
  includeCustomFields: boolean;
  includeStatuses: boolean;
  includeActivityLogs: boolean;
  includeMembers: boolean;
  selected: boolean;
}

function ProjectItem({
  item,
  onChange,
}: {
  item: ProjectOption;
  onChange: (updated: ProjectOption) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = (key: keyof ProjectOption) =>
    onChange({ ...item, [key]: !item[key] });

  return (
    <div className="border rounded-md p-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={item.selected}
          onChange={() => toggle("selected")}
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-sm font-medium flex-1">{item.name}</span>
        {item.selected && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
      {item.selected && expanded && (
        <div className="mt-2 ml-6 grid grid-cols-2 gap-1.5">
          {(
            [
              ["includeStatuses", "Statuses"],
              ["includeLabels", "Labels"],
              ["includeCustomFields", "Custom Fields"],
              ["includeMembers", "Members"],
              ["includeTasks", "Tasks"],
              ["includeComments", "Comments"],
              ["includeActivityLogs", "Activity Logs"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={item[key] as boolean}
                onChange={() => toggle(key)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Channel Selection Item ─────────────────────────────

interface ChannelOption {
  channelId: string;
  name: string;
  includeMessages: boolean;
  includeReactions: boolean;
  includeMembers: boolean;
  selected: boolean;
}

function ChannelItem({
  item,
  onChange,
}: {
  item: ChannelOption;
  onChange: (updated: ChannelOption) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = (key: keyof ChannelOption) =>
    onChange({ ...item, [key]: !item[key] });

  return (
    <div className="border rounded-md p-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={item.selected}
          onChange={() => toggle("selected")}
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-sm font-medium flex-1">#{item.name}</span>
        {item.selected && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
      {item.selected && expanded && (
        <div className="mt-2 ml-6 grid grid-cols-2 gap-1.5">
          {(
            [
              ["includeMembers", "Members"],
              ["includeMessages", "Messages"],
              ["includeReactions", "Reactions"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={item[key] as boolean}
                onChange={() => toggle(key)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Wiki Space Selection Item ───────────────────────────

interface WikiSpaceOption {
  spaceId: string;
  name: string;
  includeComments: boolean;
  selected: boolean;
}

function WikiSpaceItem({
  item,
  onChange,
}: {
  item: WikiSpaceOption;
  onChange: (updated: WikiSpaceOption) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = (key: keyof WikiSpaceOption) =>
    onChange({ ...item, [key]: !item[key] });

  return (
    <div className="border rounded-md p-3">
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={item.selected}
          onChange={() => toggle("selected")}
          className="h-4 w-4 rounded border-border"
        />
        <span className="text-sm font-medium flex-1">{item.name}</span>
        {item.selected && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
      {item.selected && expanded && (
        <div className="mt-2 ml-6 grid grid-cols-2 gap-1.5">
          {(
            [
              ["includeComments", "Comments"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={item[key] as boolean}
                onChange={() => toggle(key)}
                className="h-3.5 w-3.5 rounded border-border"
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Restore Summary Display ────────────────────────────

function SummaryDisplay({ summary }: { summary: RestoreSummary }) {
  const entries = [
    ["Projects", summary.projects],
    ["Statuses", summary.statuses],
    ["Labels", summary.labels],
    ["Custom Fields", summary.customFields],
    ["Tasks", summary.tasks],
    ["Subtasks", summary.subtasks],
    ["Comments", summary.comments],
    ["Activity Logs", summary.activityLogs],
    ["Channels", summary.channels],
    ["Messages", summary.messages],
    ["Reactions", summary.reactions],
    ["Wiki Spaces", summary.wikiSpaces],
    ["Wiki Pages", summary.wikiPages],
    ["Wiki Comments", summary.wikiComments],
    ["Images", summary.images],
  ].filter(([, count]) => (count as number) > 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {entries.map(([label, count]) => (
          <div key={label as string} className="rounded-md border p-2 text-center">
            <div className="text-lg font-semibold">{count as number}</div>
            <div className="text-xs text-muted-foreground">{label as string}</div>
          </div>
        ))}
      </div>

      {summary.userMappings.length > 0 && (
        <div>
          <h4 className="text-sm font-medium mb-1">User Mappings</h4>
          <div className="text-xs space-y-0.5">
            {summary.userMappings.map((m, i) => (
              <div key={i} className="flex items-center gap-1.5">
                {m.mappedUserId ? (
                  <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />
                ) : (
                  <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
                )}
                <span className="text-muted-foreground">
                  {m.originalName} ({m.originalEmail})
                </span>
                <span className="text-muted-foreground">→</span>
                <span>
                  {m.mappedName ?? "Not found (will use fallback)"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {summary.warnings.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-yellow-600 mb-1">Warnings</h4>
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {summary.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0 mt-0.5" />
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────

export function BackupSettings({ workspaceId }: BackupSettingsProps) {
  // ── Export state ──
  const { data: projectsData } = useProjects(workspaceId);
  const { data: channelsData } = useChannels(workspaceId);
  const { data: wikiSpacesData } = useWikiSpaces(workspaceId);
  const exportMutation = useExportBackup(workspaceId);

  const projects = projectsData?.data ?? [];
  const channels: ChatChannel[] = (channelsData?.data ?? []).filter(
    (c: ChatChannel) => c.type !== "DM",
  );
  const wikiSpaces = wikiSpacesData?.data ?? [];

  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([]);
  const [wikiSpaceOptions, setWikiSpaceOptions] = useState<WikiSpaceOption[]>([]);

  // Initialize options when data loads
  if (projects.length > 0 && projectOptions.length === 0) {
    setProjectOptions(
      projects.map((p) => ({
        projectId: p.id,
        name: p.name,
        includeTasks: true,
        includeComments: true,
        includeLabels: true,
        includeCustomFields: true,
        includeStatuses: true,
        includeActivityLogs: false,
        includeMembers: true,
        selected: false,
      })),
    );
  }

  if (channels.length > 0 && channelOptions.length === 0) {
    setChannelOptions(
      channels.map((c) => ({
        channelId: c.id,
        name: c.name ?? "Unnamed",
        includeMessages: true,
        includeReactions: true,
        includeMembers: true,
        selected: false,
      })),
    );
  }

  if (wikiSpaces.length > 0 && wikiSpaceOptions.length === 0) {
    setWikiSpaceOptions(
      wikiSpaces.map((s) => ({
        spaceId: s.id,
        name: s.name,
        includeComments: true,
        selected: false,
      })),
    );
  }

  const [includeFiles, setIncludeFiles] = useState(true);

  const selectedProjects = projectOptions.filter((p) => p.selected);
  const selectedChannels = channelOptions.filter((c) => c.selected);
  const selectedWikiSpaces = wikiSpaceOptions.filter((s) => s.selected);
  const hasSelection = selectedProjects.length > 0 || selectedChannels.length > 0 || selectedWikiSpaces.length > 0;

  function handleExport() {
    const req: BackupExportRequest = {
      projects: selectedProjects.map(({ selected, name, ...rest }) => rest),
      channels: selectedChannels.map(({ selected, name, ...rest }) => rest),
      wikiSpaces: selectedWikiSpaces.map(({ selected, name, ...rest }) => rest),
      includeFiles,
    };
    exportMutation.mutate(req, {
      onSuccess: ({ blob, filename }) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        toast.success("Backup downloaded");
      },
      onError: (err) => {
        toast.error(err.message || "Export failed");
      },
    });
  }

  // ── Restore state ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<RestoreSummary | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreSummary | null>(null);
  const previewMutation = usePreviewRestore(workspaceId);
  const restoreMutation = useExecuteRestore(workspaceId);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setRestoreFile(file);
    setPreview(null);
    setRestoreResult(null);
    previewMutation.mutate(file, {
      onSuccess: (data) => setPreview(data),
      onError: (err) => toast.error(err.message || "Failed to preview backup"),
    });
  }

  function handleRestore() {
    if (!restoreFile) return;
    restoreMutation.mutate(restoreFile, {
      onSuccess: (data) => {
        setRestoreResult(data);
        setPreview(null);
        toast.success("Restore completed successfully");
      },
      onError: (err) => toast.error(err.message || "Restore failed"),
    });
  }

  function resetRestore() {
    setRestoreFile(null);
    setPreview(null);
    setRestoreResult(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="space-y-8">
      {/* ── Create Backup ── */}
      <section>
        <h2 className="text-lg font-semibold mb-1">Create Backup</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Select the projects, channels, and wiki spaces you want to include in the backup.
        </p>
        <BackupScopeNotice action="export" />

        {projects.length > 0 && (
          <div className="mb-4">
            <Label className="text-sm font-medium mb-2 block">Projects</Label>
            <div className="space-y-2">
              {projectOptions.map((p, i) => (
                <ProjectItem
                  key={p.projectId}
                  item={p}
                  onChange={(updated) => {
                    const next = [...projectOptions];
                    next[i] = updated;
                    setProjectOptions(next);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {channels.length > 0 && (
          <div className="mb-4">
            <Label className="text-sm font-medium mb-2 block">Channels</Label>
            <div className="space-y-2">
              {channelOptions.map((c, i) => (
                <ChannelItem
                  key={c.channelId}
                  item={c}
                  onChange={(updated) => {
                    const next = [...channelOptions];
                    next[i] = updated;
                    setChannelOptions(next);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {wikiSpaces.length > 0 && (
          <div className="mb-4">
            <Label className="text-sm font-medium mb-2 block">Wiki Spaces</Label>
            <div className="space-y-2">
              {wikiSpaceOptions.map((s, i) => (
                <WikiSpaceItem
                  key={s.spaceId}
                  item={s}
                  onChange={(updated) => {
                    const next = [...wikiSpaceOptions];
                    next[i] = updated;
                    setWikiSpaceOptions(next);
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {hasSelection && (
          <div className="mb-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeFiles}
                onChange={(e) => setIncludeFiles(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="font-medium">Include files</span>
              <span className="text-muted-foreground">
                (wiki images)
              </span>
            </label>
          </div>
        )}

        <Button
          onClick={handleExport}
          disabled={!hasSelection || exportMutation.isPending}
        >
          {exportMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-2" />
          )}
          Download Backup
        </Button>
      </section>

      {/* ── Restore from Backup ── */}
      <section>
        <h2 className="text-lg font-semibold mb-1">Restore from Backup</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Upload a backup file (.zip or legacy .json) to preview and restore data into this workspace.
          Restored items are created as new entities with new IDs.
        </p>
        <BackupScopeNotice action="restore" />

        <div className="space-y-4">
          <div>
            <Label className="text-sm font-medium mb-1 block">Backup File</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.zip"
              onChange={handleFileSelect}
              className="block text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 file:cursor-pointer"
            />
          </div>

          {previewMutation.isPending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Analyzing backup file...
            </div>
          )}

          {preview && (
            <div className="border rounded-lg p-4 space-y-4">
              <h3 className="text-sm font-semibold">Restore Preview</h3>
              <SummaryDisplay summary={preview} />
              <div className="flex gap-2">
                <Button
                  onClick={handleRestore}
                  disabled={restoreMutation.isPending}
                >
                  {restoreMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4 mr-2" />
                  )}
                  Confirm Restore
                </Button>
                <Button variant="outline" onClick={resetRestore}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {restoreResult && (
            <div className="border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-950 rounded-lg p-4 space-y-4">
              <h3 className="text-sm font-semibold text-green-700 dark:text-green-400">
                Restore Complete
              </h3>
              <SummaryDisplay summary={restoreResult} />
              <p className="text-sm text-muted-foreground">
                Data has been restored successfully. Please refresh the page to see the changes.
              </p>
              <div className="flex gap-2">
                <Button onClick={() => window.location.reload()}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh Page
                </Button>
                <Button variant="outline" onClick={resetRestore}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
