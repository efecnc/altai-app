type Props = {
  title: string;
  description?: string;
};

/**
 * Section header for a settings tab. Renders as `<h2>` because the
 * settings page acts as a sub-document inside the workspace; the
 * sr-only `<h1>` in `App.tsx` ("ALTAI workspace") sits above it in the
 * outline so screen-reader users can H-navigate (h1 to global title,
 * h2 to each settings section, h3 to sub-blocks inside).
 */
export function SectionHeader({ title, description }: Props) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-[18px] font-semibold tracking-tight">{title}</h2>
      {description ? (
        <p className="text-[12px] text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
