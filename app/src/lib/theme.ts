import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "ring-theme";

function readPref(): ThemePref {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch { return "system"; }
}

/** Three-way theme preference, defaulting to the OS setting until the user
    picks one explicitly. "system" is never written to storage -- its
    absence IS the system state, so a cleared preference reverts cleanly
    rather than needing its own tombstone value. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const dark = pref === "system" ? systemDark : pref === "dark";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  function setTheme(next: ThemePref) {
    setPref(next);
    try {
      if (next === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch { /* ignore */ }
  }

  return { pref, dark, setTheme };
}
