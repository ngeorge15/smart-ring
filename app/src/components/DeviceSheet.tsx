import { Dialog } from "@base-ui/react/dialog";
import { CircleDot, Laptop, Moon, RefreshCw, Sun, X } from "lucide-react";
import { DATA } from "@/lib/data";
import { RingPage } from "@/pages/RingPage";
import type { ThemePref } from "@/lib/theme";

/**
 * Device/settings sheet: everything that used to be a persistent header
 * control or its own "Ring" tab now lives one tap away instead of always on
 * screen. Base UI's Dialog gives focus trap, scroll lock, and Escape
 * dismissal for free (modal defaults to true) -- no new dependency, no
 * hand-rolled a11y.
 */
export function DeviceSheet({ open, onOpenChange, themePref, onThemeChange, onRefresh, refreshing }: {
  open: boolean; onOpenChange: (open: boolean) => void;
  themePref: ThemePref; onThemeChange: (pref: ThemePref) => void;
  onRefresh: () => void; refreshing: boolean;
}) {
  const D = DATA.device;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className="fixed inset-0 z-[60] bg-black/45 transition-opacity duration-200
                     data-[starting-style]:opacity-0 data-[ending-style]:opacity-0
                     motion-reduce:transition-none" />
        <Dialog.Popup
          aria-label="Ring &amp; device settings"
          initialFocus={false}
          className="fixed inset-x-0 bottom-0 z-[61] max-h-[86vh] overflow-y-auto
                     rounded-t-[24px] border-t border-hairline bg-surface-1
                     pb-[calc(env(safe-area-inset-bottom)+18px)]
                     shadow-[0_-8px_30px_rgba(0,0,0,0.25)]
                     transition-transform duration-200 ease-out
                     data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full
                     motion-reduce:transition-none">
          <div className="sticky top-0 z-10 flex items-center justify-between border-b
                          border-hairline bg-surface-1/95 px-[18px] pb-3 pt-[calc(env(safe-area-inset-top)+14px)]
                          backdrop-blur-xl">
            <Dialog.Title className="text-[15px] font-[660]">Ring &amp; device</Dialog.Title>
            <Dialog.Close
              aria-label="Close device settings"
              className="flex h-9 w-9 items-center justify-center rounded-full
                         border border-hairline bg-surface-2 text-ink-2 active:scale-95">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="px-[15px] pt-3">
            <div className="rise mb-3 flex items-center gap-3 rounded-[18px] border
                            border-hairline bg-surface-1 px-[16px] py-[14px]">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center
                              rounded-full bg-surface-2">
                <CircleDot size={17} color="var(--brand)" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14.5px] font-[620]">Colmi R02</div>
                <div className="text-[12px] text-ink-3">
                  {D.charging ? "charging" : D.battery != null ? `${D.battery}% battery` : "connection state unknown"}
                </div>
              </div>
              <button onClick={onRefresh} disabled={refreshing} aria-label="Refresh dashboard"
                      className="flex h-10 items-center gap-1.5 rounded-full border border-hairline
                                 bg-surface-2 px-3 text-[12.5px] font-[560] text-ink-2
                                 active:scale-95 disabled:opacity-50">
                <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
                Refresh
              </button>
            </div>
            <ThemeSelector value={themePref} onChange={onThemeChange} />
            <RingPage />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThemeSelector({ value, onChange }: {
  value: ThemePref; onChange: (pref: ThemePref) => void;
}) {
  const OPTIONS: { id: ThemePref; label: string; Icon: typeof Sun }[] = [
    { id: "system", label: "System", Icon: Laptop },
    { id: "light", label: "Light", Icon: Sun },
    { id: "dark", label: "Dark", Icon: Moon },
  ];
  return (
    <div className="rise mb-3 rounded-[18px] border border-hairline bg-surface-1 p-[18px]">
      <h2 className="mb-3 text-[13px] font-[660] text-ink-2">Appearance</h2>
      <div className="flex gap-1.5 rounded-[11px] bg-surface-2 p-1">
        {OPTIONS.map(({ id, label, Icon }) => {
          const on = value === id;
          return (
            <button key={id} onClick={() => onChange(id)}
                    aria-pressed={on}
                    className={`flex min-h-[40px] flex-1 items-center justify-center gap-1.5
                               rounded-[9px] text-[12.5px] font-[560] transition-colors
                               ${on ? "bg-surface-1 text-ink shadow-sm" : "text-ink-3"}`}>
              <Icon size={14} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
