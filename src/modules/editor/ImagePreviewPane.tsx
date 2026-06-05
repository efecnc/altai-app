import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Props = {
  path: string;
};

export function ImagePreviewPane({ path }: Props) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    try {
      setSrc(convertFileSrc(path));
    } catch (e) {
      console.error("Failed to convert file src", e);
    }
  }, [path]);

  if (!src) return null;

  return (
    <div className="flex h-full w-full items-center justify-center bg-background/50 p-4">
      <img
        src={src}
        alt={path}
        className="max-h-full max-w-full object-contain shadow-sm"
      />
    </div>
  );
}
