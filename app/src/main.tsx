import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { initOverlay } from "@/lib/overlay";

document.documentElement.classList.add("dark");   // dark-first

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
