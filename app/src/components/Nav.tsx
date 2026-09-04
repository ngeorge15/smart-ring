import { Activity, CircleDot, Heart, Moon, Sun, TrendingUp } from "lucide-react";

export type Tab = "today" | "sleep" | "activity" | "vitals" | "trends" | "ring";

const TABS: { id: Tab; label: string; Icon: typeof Sun }[] = [
  { id: "today", label: "Today", Icon: Sun },
  { id: "sleep", label: "Sleep", Icon: Moon },
  { id: "activity", label: "Activity", Icon: Activity },
  { id: "vitals", label: "Vitals", Icon: Heart },
  { id: "trends", label: "Trends", Icon: TrendingUp },
  { id: "ring", label: "Ring", Icon: CircleDot },
];

/** Left-to-right tab order, shared with App.tsx's swipe-to-navigate so
    "swipe left" and "the next icon over" always agree. */
export const TAB_ORDER: Tab[] = TABS.map((t) => t.id);

/** Bottom bar: Apple HIG puts primary navigation in the thumb zone, and every
    control clears the 44x44pt minimum touch target. */
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
              {/* Named so App.tsx's view transition can MORPH this between tabs
                  instead of popping in fresh each time -- exactly one tab is
                  ever active, so the name stays unique across any one snapshot,
                  which is the one constraint the API places on shared names. */}
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
