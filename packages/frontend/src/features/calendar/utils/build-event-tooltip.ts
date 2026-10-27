import type { Task } from "@/features/tasks/api";

const PRIORITY_LABELS: Record<string, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

const PRIORITY_DOT_COLORS: Record<string, string> = {
  URGENT: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#3b82f6",
  LOW: "#9ca3af",
};

// Validate persisted colors as well as new API inputs: legacy data and backups
// can contain values written before the shared schemas enforced hex colors.
function safeColor(value: string | null | undefined): string {
  return typeof value === "string" &&
    /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
    ? value
    : "#9ca3af";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function textRow(text: string, css: string): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText = css;
  row.textContent = text;
  return row;
}

function colorRow(
  text: string,
  color: string | null | undefined,
): HTMLDivElement {
  const row = document.createElement("div");
  row.style.cssText =
    "display:flex;align-items:center;gap:6px;margin-bottom:4px";
  const dot = document.createElement("span");
  dot.style.cssText = "width:8px;height:8px;border-radius:50%;flex-shrink:0";
  dot.style.backgroundColor = safeColor(color);
  const label = document.createElement("span");
  label.style.fontSize = "12px";
  label.textContent = text;
  row.append(dot, label);
  return row;
}

export function buildEventTooltip(task: Task): HTMLDivElement {
  // Tippy accepts an Element as content. Keep every user-controlled string out
  // of its HTML parsing path, including values already stored in the database.
  const tooltip = document.createElement("div");
  tooltip.style.cssText = "max-width:280px;padding:4px 2px";

  tooltip.append(
    textRow(task.title, "font-weight:600;font-size:13px;margin-bottom:6px"),
    colorRow(task.status.name, task.status.color),
    colorRow(
      `${PRIORITY_LABELS[task.priority] ?? "Medium"} priority`,
      PRIORITY_DOT_COLORS[task.priority] ?? PRIORITY_DOT_COLORS.MEDIUM,
    ),
  );

  if (task.startDate || task.dueDate) {
    const dateText =
      task.startDate && task.dueDate && task.startDate !== task.dueDate
        ? `${formatShortDate(task.startDate)} – ${formatShortDate(task.dueDate)}`
        : formatShortDate((task.startDate ?? task.dueDate)!);
    tooltip.append(
      textRow(
        dateText,
        "font-size:12px;margin-bottom:4px;color:hsl(var(--muted-foreground))",
      ),
    );
  }

  if (task.assignees.length > 0) {
    const names = task.assignees.map((a) => a.user.displayName).join(", ");
    tooltip.append(
      textRow(
        names,
        "font-size:12px;margin-bottom:4px;color:hsl(var(--muted-foreground))",
      ),
    );
  }

  if (task.labels.length > 0) {
    const labels = document.createElement("div");
    labels.style.marginBottom = "4px";
    for (const { label } of task.labels) {
      const pill = document.createElement("span");
      pill.style.cssText =
        "display:inline-block;padding:1px 6px;border-radius:9999px;font-size:11px;color:#fff;margin-right:4px";
      pill.style.backgroundColor = safeColor(label.color);
      pill.textContent = label.name;
      labels.append(pill);
    }
    tooltip.append(labels);
  }

  if (task.description) {
    const plain = stripHtml(task.description);
    if (plain) {
      const truncated = plain.length > 100 ? plain.slice(0, 100) + "…" : plain;
      tooltip.append(
        textRow(
          truncated,
          "font-size:11px;color:hsl(var(--muted-foreground));margin-top:2px",
        ),
      );
    }
  }

  return tooltip;
}
