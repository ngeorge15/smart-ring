"""
Pull body profile and Apple's own active-energy series out of the Health export.

Calories from step count alone are an index, not a measurement -- the ring's
firmware has no idea how heavy you are or how hard your heart is working. With
weight, height, age and sex we can compute energy from HEART RATE instead, which
is what the Watch does.

Apple's ActiveEnergyBurned is imported alongside as a REFERENCE, so the ring's
estimate can be checked against a device that measures the same quantity rather
than being asserted to be better.
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "ring_data.sqlite"
LB_TO_KG = 0.45359237
FT_TO_CM = 30.48

# Attribute ORDER varies between exports (unit sometimes precedes startDate), so
# the type is matched first and the attributes parsed generically. A positional
# regex silently matched nothing at all.
REC = re.compile(r'<Record type="HKQuantityTypeIdentifier(BodyMass|Height|ActiveEnergyBurned)"([^>]*)')
ATTR = re.compile(r'(\w+)="([^"]*)"')
ME = re.compile(r'<Me ([^>]*)/>')


def parse(xml: Path) -> dict:
    latest = {"BodyMass": None, "Height": None}
    energy: dict[str, float] = defaultdict(float)
    profile: dict = {}

    with xml.open(encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if not profile and "<Me " in line:
                m = ME.search(line)
                if m:
                    attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
                    profile["dob"] = attrs.get("HKCharacteristicTypeIdentifierDateOfBirth")
                    sex = attrs.get("HKCharacteristicTypeIdentifierBiologicalSex", "")
                    profile["sex"] = ("male" if sex.endswith("Male")
                                      else "female" if sex.endswith("Female") else None)
            m = REC.search(line)
            if not m:
                continue
            kind = m.group(1)
            attrs = dict(ATTR.findall(m.group(2)))
            try:
                v = float(attrs["value"])
            except (KeyError, ValueError):
                continue
            day = attrs.get("startDate", "")[:10]
            unit = attrs.get("unit", "")
            if len(day) != 10:
                continue
            if kind == "ActiveEnergyBurned":
                energy[day] += v          # unit is "Cal" == kcal
            else:
                # keep the most recent measurement of each
                if latest[kind] is None or day >= latest[kind][0]:
                    latest[kind] = (day, v, unit)

    if latest["BodyMass"]:
        _, v, unit = latest["BodyMass"]
        profile["weight_kg"] = round(v * LB_TO_KG if unit == "lb" else v, 1)
    if latest["Height"]:
        _, v, unit = latest["Height"]
        profile["height_cm"] = round(v * FT_TO_CM if unit == "ft" else v, 1)
    return {"profile": profile, "active_energy": dict(energy)}


def main() -> None:
    xml = Path(sys.argv[1] if len(sys.argv) > 1
               else "/tmp/ahx/apple_health_export/export.xml")
    if not xml.exists():
        raise SystemExit(f"no export at {xml}")
    out = parse(xml)

    cfg_path = ROOT / "config.json"
    cfg = json.loads(cfg_path.read_text())
    cfg["body"] = {**out["profile"],
                   "source": "Apple Health export",
                   "notes": "Used for heart-rate based energy expenditure. "
                            "Update weight here if it changes."}
    cfg_path.write_text(json.dumps(cfg, indent=2) + "\n")

    conn = sqlite3.connect(DB)
    n = 0
    for day, kcal in out["active_energy"].items():
        conn.execute(
            "INSERT OR REPLACE INTO reference_samples "
            "(source, kind, start_ts, end_ts, value, stage, unit) "
            "VALUES ('apple','active_energy',?,?,?,'','kcal')",
            (day, day, round(kcal, 1)))
        n += 1
    conn.commit(); conn.close()

    print(json.dumps(out["profile"], indent=1))
    print(f"active_energy days imported: {n}")


if __name__ == "__main__":
    main()
