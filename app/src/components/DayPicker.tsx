import { ChevronLeft, ChevronRight } from "lucide-react";
import { useSwipe } from "@/lib/useSwipe";

/** Calendar dates in the snapshot are local dates, so compare them with a
    local YYYY-MM-DD key. toISOString() crosses a day boundary in time zones
    west of UTC during the evening. */
function localDayKey(d = new Date()) {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"),
          String(d.getDate()).padStart(2, "0")].join("-");
}

/** Step through days. Disabled ends make it obvious where the data stops,
    rather than silently doing nothing when you tap past the edge. */
export function DayPicker({ days, index, onChange }: {
  days: string[]; index: number; onChange: (i: number) => void;
}) {
  const atOldest = index <= 0;
  const atNewest = index >= days.length - 1;
  // Swipe left = forward in time (newer), matching the chevron on that side --
  // a left swipe brings the NEXT day in, same direction as paging forward.
  // Called unconditionally, ABOVE the length<=1 early return: React hooks
  // must run in the same order on every render, early-return or not.
  const swipe = useSwipe(
    () => !atNewest && onChange(index + 1),
    () => !atOldest && onChange(index - 1),
  );
  if (!days.length) return null;
  const day = days[index];
  const d = new Date(day + "T12:00");
  const isToday = day === localDayKey();

  if (days.length === 1) {
    return (
      <div className="rise mb-3 rounded-[18px] border border-hairline bg-surface-1 px-4 py-3 text-center">
        <div className="text-[14px] font-[600] tracking-tight">
          {isToday ? "Today" : d.toLocaleDateString(undefined,
            { weekday: "long", month: "short", day: "numeric" })}
        </div>
        <div className="text-[11px] text-ink-3">Only day recorded</div>
      </div>
    );
  }

  return (
    <div {...swipe}
         className="rise mb-3 flex items-center justify-between rounded-[18px]
                    border border-hairline bg-surface-1 px-1 py-1">
      <button onClick={() => !atOldest && onChange(index - 1)} disabled={atOldest}
              aria-label="Previous day"
              className="flex h-11 w-11 items-center justify-center rounded-full
                         text-ink-2 disabled:opacity-25 active:opacity-60">
        <ChevronLeft size={18} />
      </button>
      <div className="text-center">
        <div className="text-[14px] font-[600] tracking-tight">
          {isToday ? "Today" : d.toLocaleDateString(undefined,
            { weekday: "long", month: "short", day: "numeric" })}
        </div>
        <div className="text-[11px] text-ink-3">{index + 1} of {days.length} days</div>
      </div>
      <button onClick={() => !atNewest && onChange(index + 1)} disabled={atNewest}
              aria-label="Next day"
              className="flex h-11 w-11 items-center justify-center rounded-full
                         text-ink-2 disabled:opacity-25 active:opacity-60">
        <ChevronRight size={18} />
      </button>
    </div>
  );
}
