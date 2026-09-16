import { HeartPulse, Sun, TrendingUp } from "lucide-react";

export type Tab = "today" | "metrics" | "trends";

const TABS: { id: Tab; label: string; Icon: typeof Sun }[] = [
  { id: "today", label: "Today", Icon: Sun },
  { id: "metrics", label: "Metrics", Icon: HeartPulse },
  { id: "trends", label: "Trends", Icon: TrendingUp },
];

/** Left-to-right tab order, shared with App.tsx's swipe-to-navigate so
    "swipe left" and "the next icon over" always agree. */
export const TAB_ORDER: Tab[] = TABS.map((t) => t.id);

/** Bottom bar: Apple HIG puts primary navigation in the thumb zone, and every
    control clears the 44x44pt minimum touch target. Three tabs, not six --
    Sleep/Activity/Vitals live inside Metrics now, and Ring/sync/settings
    moved into the device sheet off the header. */
export function Nav({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-hairline
                    bg-surface-1/85 backdrop-blur-xl"
         style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      <div className="mx-auto flex max-w-[720px]">
        {TABS.map(({ id, label, Icon }) => {
          const on = tab === id;
          return (
            <button key={id} onClick={() => onChange(id)}
                    aria-current={on ? "page" : undefined}
                    className="relative flex min-h-[52px] flex-1 flex-col items-center
                               justify-center gap-[3px] pt-1.5 pb-1 transition-colors
                               active:opacity-60">
              {on && (
                <span aria-hidden style={{ viewTransitionName: "nav-active" }}
                      className="absolute inset-x-1.5 inset-y-0.5 rounded-[14px] bg-surface-2" />
              )}
              <Icon size={20} strokeWidth={on ? 2.4 : 1.9} className="relative"
                    color={on ? "var(--brand)" : "var(--ink-3)"} />
              <span className="relative text-[10px] font-[560] tracking-[0.01em]"
                    style={{ color: on ? "var(--brand)" : "var(--ink-3)" }}>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
