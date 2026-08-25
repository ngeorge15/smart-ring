import { useState } from "react";
import { DATA } from "@/lib/data";
import { SeriesChart } from "@/components/SeriesChart";
import { HeartRateCard } from "@/components/HeartRateCard";
import { DayPicker } from "@/components/DayPicker";

export function Vitals() {
  const days = [...new Set(
    Object.values(DATA.series_detail ?? {}).flat().map((r) => r.day)
  )].sort();
  const [i, setI] = useState(Math.max(0, days.length - 1));
  const day = days[i];

  return (
    <>
      <HeartRateCard />
      <DayPicker days={days} index={i} onChange={setI} />
      <SeriesChart kind="temp_raw" title="Temperature" unit="°F"
                   decimals={1} day={day} transform={(raw) => (raw / 10 + 20) * 9 / 5 + 32} />
      <SeriesChart kind="spo2" title="Blood oxygen" unit="%" day={day} />
      <SeriesChart kind="hrv" title="HRV" unit=" ms" day={day} />
      <SeriesChart kind="stress" title="Stress" unit="" day={day} />
    </>
  );
}
