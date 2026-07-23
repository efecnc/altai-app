import { cn } from "@/lib/utils";
import { openChatHref, openWorkspaceFile } from "@/modules/ai/lib/openChatHref";
import type { MouseEvent, ReactNode } from "react";

type ChatPathLinkProps = {
  path: string;
  className?: string;
  title?: string;
  children?: ReactNode;
};

/** Clickable workspace path that opens the file in the editor. */
export function ChatPathLink({
  path,
  className,
  title,
  children,
}: ChatPathLinkProps) {
  if (!path.trim()) return null;
  return (
    <button
      type="button"
      className={cn(
        "min-w-0 max-w-full truncate text-left hover:underline",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      title={title ?? path}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openWorkspaceFile(path);
      }}
    >
      {children ?? path}
    </button>
  );
}

type ChatExternalLinkProps = {
  href: string;
  className?: string;
  children?: ReactNode;
};

/** External URL that opens via Tauri opener (not window.open). */
export function ChatExternalLink({
  href,
  className,
  children,
}: ChatExternalLinkProps) {
  if (!href.trim()) return null;
  return (
    <a
      href={href}
      className={cn(
        "cursor-pointer hover:underline",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        e.stopPropagation();
        void openChatHref(href);
      }}
    >
      {children ?? href}
    </a>
  );
}
