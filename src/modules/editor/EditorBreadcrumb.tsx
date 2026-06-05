import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  copyToClipboard,
  relativePath,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";

type Segment = {
  label: string;
  fullPath: string;
  isFile: boolean;
};

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}

function basename(p: string): string {
  const n = normalize(p).replace(/\/+$/, "");
  const i = n.lastIndexOf("/");
  return i >= 0 ? n.slice(i + 1) : n;
}

/**
 * Build breadcrumb segments for a file, anchored at the workspace root when the
 * file lives under it (so the chain reads project → … → file). Falls back to the
 * file's parent directory when there's no root or the file is outside it.
 */
function buildSegments(filePath: string, root: string | null): Segment[] {
  // `normalize` only swaps "\\" → "/", so indices line up 1:1 with `filePath`.
  // We compute boundaries on the normalized string but slice `fullPath` from the
  // ORIGINAL path so it keeps native separators — every other caller of
  // revealInFinder passes native paths, and forward slashes break it on Windows.
  const norm = normalize(filePath);
  const normRoot = root ? normalize(root).replace(/\/+$/, "") : null;

  // Index in `norm` (== index in `filePath`) where the base directory ends.
  let baseEnd: number;
  if (normRoot && (norm === normRoot || norm.startsWith(normRoot + "/"))) {
    baseEnd = normRoot.length;
  } else {
    const i = norm.lastIndexOf("/");
    baseEnd = i > 0 ? i : i === 0 ? 1 : 0;
  }

  const baseSlice = norm.slice(0, baseEnd);
  const segments: Segment[] = [
    {
      label: basename(baseSlice) || baseSlice || "/",
      fullPath: filePath.slice(0, baseEnd) || filePath,
      isFile: false,
    },
  ];

  // Walk the remaining "/"-separated parts, tracking the running index so each
  // fullPath is sliced from the original (native-separator) path.
  let idx = baseEnd;
  while (idx < norm.length) {
    if (norm[idx] === "/") {
      idx++;
      continue;
    }
    let end = norm.indexOf("/", idx);
    if (end === -1) end = norm.length;
    segments.push({
      label: norm.slice(idx, end),
      fullPath: filePath.slice(0, end),
      isFile: end === norm.length,
    });
    idx = end;
  }
  return segments;
}

type Props = {
  path: string;
  /** Workspace root, used to anchor the breadcrumb and for copy-relative-path. */
  root: string | null;
};

/**
 * A thin, interactive breadcrumb bar above the active editor showing where the
 * file sits in the project. Directory segments reveal the folder in the OS file
 * manager; the file segment copies its workspace-relative path (#64).
 */
export function EditorBreadcrumb({ path, root }: Props) {
  const segments = buildSegments(path, root);
  const iconUrl = fileIconUrl(basename(path));

  return (
    <div className="flex h-7 shrink-0 items-center overflow-x-auto border-b border-border/50 px-2 [scrollbar-width:none]">
      <Breadcrumb>
        <BreadcrumbList className="flex-nowrap gap-1 text-[11px] sm:gap-1">
          {segments.map((seg, idx) => {
            const isLast = idx === segments.length - 1;
            return (
              <BreadcrumbItem key={seg.fullPath} className="shrink-0">
                {seg.isFile ? (
                  // A single interactive element (not a button nested inside a
                  // role="link" BreadcrumbPage, which is an invalid a11y tree).
                  <button
                    type="button"
                    aria-current="page"
                    onClick={() =>
                      void copyToClipboard(relativePath(root ?? "", path))
                    }
                    title="Copy relative path"
                    className="flex cursor-pointer items-center gap-1 font-medium text-foreground hover:text-foreground"
                  >
                    {iconUrl ? (
                      <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
                    ) : null}
                    <span className="truncate">{seg.label}</span>
                  </button>
                ) : (
                  <>
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        onClick={() => void revealInFinder(seg.fullPath)}
                        title={`Reveal ${seg.label} in file manager`}
                        className="cursor-pointer truncate text-muted-foreground hover:text-foreground"
                      >
                        {seg.label}
                      </button>
                    </BreadcrumbLink>
                    {!isLast ? <BreadcrumbSeparator /> : null}
                  </>
                )}
              </BreadcrumbItem>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </div>
  );
}
