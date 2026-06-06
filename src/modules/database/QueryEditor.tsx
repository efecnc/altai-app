import { buildSharedExtensions } from "@/modules/editor/lib/extensions";
import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { useTheme } from "@/modules/theme";
import { Prec, type Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";

// A trimmed basicSetup for a query box — no fold gutter or active-line
// highlight, which add noise to a few-line editor.
const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: false,
  highlightActiveLineGutter: false,
  highlightActiveLine: false,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
} as const;

interface QueryEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
}

export function QueryEditor({ value, onChange, onRun }: QueryEditorProps) {
  const { resolvedTheme } = useTheme();
  const [sqlLang, setSqlLang] = useState<Extension | null>(null);

  // Reuse the editor's SQL language resolver (StreamLanguage-wrapped legacy
  // mode). Loaded by a synthetic ".sql" filename since there is no real file.
  useEffect(() => {
    let alive = true;
    void resolveLanguage("query.sql").then((ext) => {
      if (alive) setSqlLang(ext);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Keep the latest onRun without rebuilding the keymap extension on each change.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;

  const extensions = useMemo(() => {
    const exts: Extension[] = [...buildSharedExtensions()];
    if (sqlLang) exts.push(sqlLang);
    exts.push(
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onRunRef.current();
              return true;
            },
          },
        ]),
      ),
    );
    return exts;
  }, [sqlLang]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={resolvedTheme}
      extensions={extensions}
      height="100%"
      className="h-full"
      basicSetup={BASIC_SETUP}
    />
  );
}
