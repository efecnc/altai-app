"use client";

import { cn } from "@/lib/utils";
import { memo } from "react";

/**
 * Compact markdown heading/body overrides for the chat transcript.
 *
 * Streamdown's defaults are document-grade — h1 is `text-3xl` (30px), which
 * dwarfs a 12px chat body and reads as a page title rather than a section
 * marker. Kilo-Code renders assistant headings as subtle visual anchors:
 * small, semibold, tightly spaced. These overrides do the same so a model
 * that leans on `#`/`##` headings doesn't blow up the transcript layout.
 *
 * Each renderer keeps the default `mt-*` rhythm (collapsed on the first child
 * via the `[&>*:first-child]:mt-0` rule on the Streamdown container) but
 * shrinks the type to chat scale.
 */

type ElProps = {
  className?: string;
  children?: React.ReactNode;
  node?: unknown;
};

const H1 = memo(function ChatH1({ className, children }: ElProps) {
  return (
    <h1
      className={cn(
        "mt-4 mb-1.5 font-semibold text-[14.5px] leading-snug text-foreground",
        className,
      )}
    >
      {children}
    </h1>
  );
});

const H2 = memo(function ChatH2({ className, children }: ElProps) {
  return (
    <h2
      className={cn(
        "mt-4 mb-1.5 font-semibold text-[13.5px] leading-snug text-foreground",
        className,
      )}
    >
      {children}
    </h2>
  );
});

const H3 = memo(function ChatH3({ className, children }: ElProps) {
  return (
    <h3
      className={cn(
        "mt-3.5 mb-1 font-semibold text-[12.5px] leading-snug text-foreground",
        className,
      )}
    >
      {children}
    </h3>
  );
});

const H4 = memo(function ChatH4({ className, children }: ElProps) {
  return (
    <h4
      className={cn(
        "mt-3 mb-1 font-semibold text-[12px] leading-snug text-foreground",
        className,
      )}
    >
      {children}
    </h4>
  );
});

const H5 = memo(function ChatH5({ className, children }: ElProps) {
  return (
    <h5
      className={cn(
        "mt-3 mb-1 font-semibold text-[11.5px] leading-snug text-foreground",
        className,
      )}
    >
      {children}
    </h5>
  );
});

const H6 = memo(function ChatH6({ className, children }: ElProps) {
  return (
    <h6
      className={cn(
        "mt-3 mb-1 font-semibold text-[11px] leading-snug text-muted-foreground",
        className,
      )}
    >
      {children}
    </h6>
  );
});

/**
 * Component map merged with the code-block override in `MessageResponse`.
 * Only headings are remapped here — lists, tables, blockquotes, and links all
 * inherit Streamdown's sensible defaults (already themed to the app palette).
 */
export const chatMarkdownComponents = {
  h1: H1,
  h2: H2,
  h3: H3,
  h4: H4,
  h5: H5,
  h6: H6,
};
