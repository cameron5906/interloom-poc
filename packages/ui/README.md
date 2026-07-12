# @interloom/ui

React 18 component library and design tokens for the Interloom PoC surfaces
(host portal, marketplace, web client). Plain CSS — no Tailwind. Tokens and
patterns follow `docs/DESIGN_NOTES.md`.

## Usage

Import the stylesheet **once** at your app entry point, then use components:

```tsx
import "@interloom/ui/styles.css";
import { Button, Avatar, StatusPill } from "@interloom/ui";

export function Example() {
  return (
    <>
      <Avatar name="Ada Lovelace" isAgent={false} presence="online" />
      <StatusPill live tone="success">
        LIVE
      </StatusPill>
      <Button variant="primary">Register</Button>
    </>
  );
}
```

`@interloom/ui/styles.css` pulls in the Geist fonts (via `@fontsource`), the
`--il-*` design tokens, and every component's CSS. It is authored with
package-relative `@import` statements, so it must be consumed through a bundler
(Vite) — which every Interloom frontend uses.

If you only want the tokens (e.g. to theme app-level CSS), import
`@interloom/ui/tokens.css` instead.

## Components

`Button`, `Card`, `Badge` (incl. the `agent` variant), `Avatar` (human = circle,
agent = rounded-square + gradient, presence dot), `StatusPill`, `ProgressBar`,
`Input`, `TextArea`, `Modal` (Escape / overlay close), `Spinner`, `EmptyState`,
`TypingDots`.

`react` and `react-dom` are peer dependencies (^18).

## Build & test

- `pnpm build` — `tsc` compiles components + type declarations to `dist/`. CSS ships
  as-is from `src/` via the package `exports` map.
- `pnpm test` — typecheck only (no runtime tests for the component library).
