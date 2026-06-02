import { useLiveRegionStore } from "./liveRegionStore";

/**
 * Single app-wide polite live region. Mounted once near the root so transient,
 * non-chat async results (file written, command done, auth failures) are
 * announced to screen reader users without stealing focus.
 */
export function LiveRegion() {
  const message = useLiveRegionStore((s) => s.message);
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
