import { ChevronLeft, ChevronRight } from "lucide-react";

/** Step through days. Disabled ends make it obvious where the data stops,
    rather than silently doing nothing when you tap past the edge. */
export function DayPicker({ days, index, onChange }: {
  days: string[]; index: number; onChange: (i: number) => void;
}) {
  if (days.length <= 1) return null;
  const day = days[index];
  const atOldest = index <= 0;
  const atNewest = index >= days.length - 1;
  const d = new Date(day + "T12:00");
  const isToday = day === new Date().toISOString().slice(0, 10);

  return (
    <div className="rise mb-3 flex items-center justify-between rounded-[13px]
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
