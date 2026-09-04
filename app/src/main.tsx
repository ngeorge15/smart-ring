import * as React from "react";
import * as ReactDOM from "react-dom";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { initOverlay } from "@/lib/overlay";

document.documentElement.classList.add("dark");   // dark-first

/* Runtime a11y checks, dev-only. Complementary to jsx-a11y in .oxlintrc.json,
   not redundant with it: static linting catches missing attributes/roles in
   source, axe catches things only visible after render -- actual contrast
   ratios, the resolved ARIA tree. `import.meta.env.DEV` is compiled to a
   literal `false` in the production build, so this and the axe-core bundle
   it pulls in are dead-code-eliminated from the shipped single-file page. */
if (import.meta.env.DEV) {
  import("@axe-core/react").then(({ default: axe }) => axe(React, ReactDOM, 1000));
}

/* Merge any handed-over capture BEFORE the first render.
   DATA is imported directly by every page, so patching it up front means no
   page needs to know an overlay exists -- and nothing renders the Mac's older
   numbers first and then visibly swaps them. A failure here must never stop the
   app booting: the cached snapshot on its own is still a working dashboard. */
initOverlay()
  .catch((e) => console.error("[ring] overlay failed", e))
  .finally(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode><App /></StrictMode>,
    );
  });
