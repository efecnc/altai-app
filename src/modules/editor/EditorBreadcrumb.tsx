import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
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
  const file = normalize(filePath);
  const normRoot = root ? normalize(root).replace(/\/+$/, "") : null;

  let baseDir: string;
  let tail: string;
  if (normRoot && (file === normRoot || file.startsWith(normRoot + "/"))) {
    baseDir = normRoot;
    tail = file.slice(normRoot.length).replace(/^\//, "");
  } else {
    const i = file.lastIndexOf("/");
    baseDir = i > 0 ? file.slice(0, i) : "/";
    tail = i >= 0 ? file.slice(i + 1) : file;
  }

  const parts = tail ? tail.split("/").filter(Boolean) : [];
  const segments: Segment[] = [
    { label: basename(baseDir) || baseDir, fullPath: baseDir, isFile: false },
  ];
  let acc = baseDir;
  parts.forEach((part, idx) => {
    acc = acc.endsWith("/") ? acc + part : acc + "/" + part;
    segments.push({ label: part, fullPath: acc, isFile: idx === parts.length - 1 });
  });
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
                  <BreadcrumbPage className="flex items-center gap-1 font-medium text-foreground">
                    {iconUrl ? (
                      <img src={iconUrl} alt="" className="size-3.5 shrink-0" />
                    ) : null}
                    <button
                      type="button"
                      onClick={() =>
                        void copyToClipboard(relativePath(root ?? "", path))
                      }
                      title="Copy relative path"
                      className="cursor-pointer truncate hover:text-foreground"
                    >
                      {seg.label}
                    </button>
                  </BreadcrumbPage>
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
