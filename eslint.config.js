// Accessibility lint gate. Intentionally narrow: this config exists to keep
// the screen-reader work from regressing, so it runs ONLY eslint-plugin-jsx-a11y
// over the React/TSX sources. It is not a general code-style linter.
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**", "**/*.mjs", "**/*.cjs"],
  },
  {
    // a11y is the only gate; existing `eslint-disable react-hooks/*` and
    // `no-console` directives in the sources reference rules this narrow config
    // doesn't run, so don't flag them as unused.
    linterOptions: { reportUnusedDisableDirectives: "off" },
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "jsx-a11y": jsxA11y,
      // Registered only so the pre-existing `// eslint-disable react/...` and
      // `react-hooks/...` directives resolve to known rules. The rules
      // themselves stay off — this gate is a11y-scoped.
      "react-hooks": reactHooks,
      react,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // autoFocus is used deliberately on transient inputs (clone-URL field,
      // model search) where moving focus into the just-opened control is the
      // correct SR behaviour, not a hazard.
      "jsx-a11y/no-autofocus": "off",
      // Radix primitives are the real controls inside our <label>s.
      "jsx-a11y/label-has-associated-control": [
        "error",
        { controlComponents: ["Checkbox", "Switch", "RadioGroupItem"], assert: "either" },
      ],
    },
  },
  {
    // Vendored shadcn primitives ship a click-to-focus convenience on the
    // addon wrapper; the wrapped <input> is the real keyboard-reachable
    // control. These are upstream-maintained, not our interaction surfaces.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-noninteractive-element-interactions": "off",
      "jsx-a11y/no-static-element-interactions": "off",
    },
  },
  {
    // The explorer's outer container is the keyboard controller (tabIndex +
    // arrow/expand handlers); the `role="tree"` + `treeitem` semantics live on
    // the inner virtualized list it wraps, so SR users get full tree structure.
    files: ["src/modules/explorer/FileExplorer.tsx"],
    rules: {
      "jsx-a11y/no-static-element-interactions": "off",
      "jsx-a11y/no-noninteractive-tabindex": "off",
    },
  },
];
