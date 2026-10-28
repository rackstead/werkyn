import { sanitizeDescriptionHtml } from "@/lib/description-html";

interface SafeHtmlProps extends React.HTMLAttributes<HTMLDivElement> {
  html: string;
}

// Renders stored task-description HTML through the description allow-list.
export function SafeHtml({ html, ...props }: SafeHtmlProps) {
  return (
    <div
      {...props}
      dangerouslySetInnerHTML={{ __html: sanitizeDescriptionHtml(html) }}
    />
  );
}
