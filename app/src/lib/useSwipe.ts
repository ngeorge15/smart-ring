import { useRef } from "react";

/**
 * Horizontal swipe, decided on release rather than mid-drag.
 *
 * Deliberately does not call preventDefault or track touchmove: vertical
 * scroll inside these pages must keep working untouched, and a swipe that's
 * mostly vertical (more Y movement than X) is treated as a scroll gesture,
 * not a navigation one, so scrolling never gets mistaken for a tab change.
 */
export function useSwipe(onLeft: () => void, onRight: () => void, threshold = 60) {
  const start = useRef<{ x: number; y: number } | null>(null);

  return {
    onTouchStart(e: React.TouchEvent) {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd(e: React.TouchEvent) {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < threshold || Math.abs(dx) < Math.abs(dy)) return;
      // Stop here so a swipe handled by a NESTED useSwipe (DayPicker, inside
      // the page-level swipe-between-tabs wrapper) doesn't also register as
      // a tab change -- only an unhandled swipe should ever bubble.
      e.stopPropagation();
      if (dx < 0) onLeft(); else onRight();
    },
  };
}
