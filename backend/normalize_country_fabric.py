"""Normalize country_of_origin and fabric_content in wms_inventory + wms_boxes.

Country strategy:
  - Curated list of canonical countries.
  - For each value in DB: if it's already canonical, skip. Otherwise compute
    Levenshtein distance to each canonical; if the BEST match is within
    MAX_DIST AND share at least the first 2 letters, remap. Otherwise leave
    as-is and report under UNRESOLVED.
  - This avoids "INDIA -> CHINA" / "USA -> CHINA" disasters.

Fabric strategy:
  - DO NOT auto-remap by similarity (a digit change = different fabric).
  - Only normalize whitespace: collapse multiple spaces, trim.
  - Anything that looks like a country (no '%' and matches a canonical
    country) is reported but NOT changed automatically.

Also seeds wms_catalog_options (type=countries) with the canonical list so
the Inventory dropdown stays clean even if new dirty data lands later.

Run:
    python normalize_country_fabric.py       # DRY-RUN
    APPLY=1 python normalize_country_fabric.py
"""
import asyncio
import os
import re
from collections import Counter

from deps import db

# Canonical country list. Order matters: longer / more specific names first so
# 'EL SALVADOR' isn't shadowed by 'SALVADOR' substring matches.
CANONICAL_COUNTRIES = [
    "BANGLADESH",
    "PAKISTAN",
    "NICARAGUA",
    "REPUBLICA DOMINICANA",
    "DOMINICAN REPUBLIC",
    "HAITI",
    "HONDURAS",
    "GUATEMALA",
    "EL SALVADOR",
    "MEXICO",
    "CHINA",
    "INDIA",
    "VIETNAM",
    "USA",
]

# Explicit aliases — applied BEFORE the fuzzy match. The values on the right
# are SOURCE strings, the keys are the target canonical. Anything not listed
# here goes through fuzzy match.
EXPLICIT_ALIASES = {
    "REPUBLICA DOMINICANA": [
        "DOMINICANA", "DOMINICAQNA", "REP DOMINICANA", "REP, DOMINICANA",
        "REP,DOMINICANA", "REPUBLICA DOMINICANAREPUBLICA DOMINICANA",
        "REPUBLICA DOMINICA", "REPUBLICA  DOMINICANA", "REPUBLICA   DOMINICANA",
        "RAPUBLICA  DOMINICANA", "EPUBLICA DOMINICANA", "REPUBLICADOMINICANA",
        "REPUBLICA DOMIICANA", "RPUBLICA DOMINICANA", "RREPUBLICA DOMINICANA",
        "RUBLICA DOMINICANA",
    ],
    "DOMINICAN REPUBLIC": [
        "DOMINICANA RE[UBLIC",
    ],
    "EL SALVADOR": [
        "SALVADOR", "SALBADOR", "EI  SALVADOR", "SALIVADOR", "SALVADAR",
    ],
    "CHINA": [
        "MADE IN CHINA",
    ],
    # BANGLADESH typos where the prefix gets mangled (first letter swapped or
    # missing). Caught explicitly so the fuzzy prefix rule can stay strict.
    "BANGLADESH": [
        "BLANGADESH", "BLANGLADESH", "BNAGLADESH", "BNGLADESH", "BGLADESH",
        "ANGLADESH", "MANGLADESH", "BVANGLADESH", "BSANGLADESH", "BBANGLADESH",
        "BANDAGLESH", "BANGKADESH", "BASNGLADESH", "BANGLADRESH", "BANGLADHS",
        "BADANGLESH", "BLANDAGLESH", "LANGADESH", "B ANGLADESH",
        "BANGLADESH1008",
    ],
    "PAKISTAN": [
        "PKISTAN", "PASKISTAN", "PANISTAN", "PAKIUSTAN", "PAKITAN", "BAKISTAN",
    ],
    "NICARAGUA": [
        "NACARAGUA", "NCARAGUA",
    ],
    "INDIA": [
        "HINDIA",
    ],
    "HAITI": [
        "AITI",
    ],
    "HONDURAS": [
        "ONDURAS", "HNDURAS", "HODURAS",
    ],
}

# Values that aren't countries at all -> clear (set to ''). Anything with a
# percentage symbol is fabric content that leaked into the country field.
COUNTRY_GARBAGE = {".", ".23", "WASH COLD", "BANGLADESHPAKISTAN"}


def is_fabric_in_country(v: str) -> bool:
    """A '%' in a country value almost always means fabric content leaked
    in. Treat as garbage so we clear it."""
    return "%" in v

MAX_DIST = 3            # max Levenshtein distance for fuzzy country match
MIN_PREFIX_LEN = 2      # first N letters must match for fuzzy mapping


def levenshtein(a: str, b: str) -> int:
    a, b = a.upper(), b.upper()
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(curr[-1] + 1, prev[j] + 1, prev[j-1] + (ca != cb)))
        prev = curr
    return prev[-1]


def normalize_ws(s: str) -> str:
    """Collapse internal whitespace runs to single space, strip ends."""
    if not s:
        return s
    return re.sub(r"\s+", " ", s).strip()


def build_country_map(distinct_values: list[str]) -> tuple[dict, list]:
    """Returns (mapping, unresolved).
    mapping: { source_value: canonical_value }
    unresolved: [ source_value, ... ]  -- values we won't touch.
    """
    explicit_lookup = {}
    for canon, aliases in EXPLICIT_ALIASES.items():
        for a in aliases:
            explicit_lookup[a.upper()] = canon

    mapping = {}
    unresolved = []
    for raw in distinct_values:
        if not raw:
            continue
        v = raw.strip().upper()
        v_collapsed = normalize_ws(v)

        # Already canonical (with whitespace normalized)
        if v_collapsed in CANONICAL_COUNTRIES:
            if v != v_collapsed:
                mapping[raw] = v_collapsed   # just a whitespace fix
            continue

        # Garbage -> clear (explicit junk or fabric content that leaked in)
        if v_collapsed in COUNTRY_GARBAGE or is_fabric_in_country(v_collapsed):
            mapping[raw] = ""
            continue

        # Explicit alias
        if v_collapsed in explicit_lookup:
            mapping[raw] = explicit_lookup[v_collapsed]
            continue
        if v in explicit_lookup:
            mapping[raw] = explicit_lookup[v]
            continue

        # Fuzzy match within MAX_DIST AND share initial prefix
        best, best_d = None, 999
        for c in CANONICAL_COUNTRIES:
            d = levenshtein(v_collapsed, c)
            if d < best_d:
                best_d, best = d, c
        prefix_ok = best and v_collapsed[:MIN_PREFIX_LEN] == best[:MIN_PREFIX_LEN]
        if best and best_d <= MAX_DIST and prefix_ok:
            mapping[raw] = best
        else:
            unresolved.append(raw)

    return mapping, unresolved


def build_fabric_map(distinct_values: list[str]) -> tuple[dict, list]:
    """Whitespace cleanup + clear country names that leaked into fabric_content.
    Any value without '%' that matches a known country (or BANGLADESH typo)
    is set to empty — those rows literally have country data in the wrong
    column and we'd rather lose the bad value than keep it as fabric."""
    mapping = {}
    flagged = []
    canonicals_upper = set(CANONICAL_COUNTRIES)
    for raw in distinct_values:
        if not raw:
            continue
        v_norm = normalize_ws(raw)
        upper = v_norm.upper()
        looks_like_country = (
            "%" not in upper and (
                upper in canonicals_upper
                or any(c in upper for c in ("BANGLAD", "PAKIST", "NICARAG", "HAITI", "HONDURAS"))
            )
        )
        if looks_like_country:
            mapping[raw] = ""
            flagged.append(raw)
            continue
        if v_norm != raw:
            mapping[raw] = v_norm
    return mapping, flagged


async def analyze_and_plan(collection: str, field: str, map_builder):
    coll = db[collection]
    counts = Counter()
    pipeline = [{"$group": {"_id": f"${field}", "n": {"$sum": 1}}}]
    async for row in coll.aggregate(pipeline):
        if row["_id"] is not None:
            counts[row["_id"]] = row["n"]

    distinct = list(counts.keys())
    mapping, extra = map_builder(distinct)
    affected = sum(counts[k] for k in mapping)
    print(f"\n[{collection}.{field}]  distinct={len(distinct)}  mapped={len(mapping)} ({affected} rows)  extra/flag={len(extra)}")

    # Top remaps
    sample = sorted(mapping.items(), key=lambda kv: -counts.get(kv[0], 0))[:25]
    for src, dst in sample:
        print(f"  {counts.get(src, 0):>5} x  {src!r:50} -> {dst!r}")

    if extra:
        print(f"\n  Flagged / unresolved (showing first 25):")
        for v in sorted(extra, key=lambda x: -counts.get(x, 0))[:25]:
            print(f"  {counts.get(v, 0):>5} x  {v!r}")

    return mapping


async def apply_mapping(collection: str, field: str, mapping: dict) -> int:
    """Apply each (src -> dst) as an update_many. Returns total docs modified."""
    coll = db[collection]
    total = 0
    for src, dst in mapping.items():
        res = await coll.update_many({field: src}, {"$set": {field: dst}})
        total += res.modified_count
    return total


async def seed_country_catalog():
    """Ensure wms_catalog_options has type=countries seeded with canonical list
    so the inventory dropdown ignores raw distinct values once we clean up."""
    existing = {
        doc["value"] for doc in await db.wms_catalog_options.find(
            {"type": "countries"}, {"_id": 0, "value": 1}
        ).to_list(2000)
    }
    to_insert = [
        {"type": "countries", "value": c, "active": True}
        for c in CANONICAL_COUNTRIES if c not in existing
    ]
    if to_insert:
        await db.wms_catalog_options.insert_many(to_insert)
    return len(to_insert)


async def main():
    apply = os.environ.get("APPLY") == "1"
    print(f"Mode: {'APPLY' if apply else 'DRY-RUN'}")

    inv_country = await analyze_and_plan("wms_inventory", "country_of_origin", build_country_map)
    box_country = await analyze_and_plan("wms_boxes", "country_of_origin", build_country_map)
    rec_country = await analyze_and_plan("wms_receiving", "country_of_origin", build_country_map)
    inv_fabric = await analyze_and_plan("wms_inventory", "fabric_content", build_fabric_map)
    box_fabric = await analyze_and_plan("wms_boxes", "fabric_content", build_fabric_map)
    rec_fabric = await analyze_and_plan("wms_receiving", "fabric_content", build_fabric_map)

    if not apply:
        print("\n[DRY-RUN] No changes written. Run with APPLY=1 to commit.")
        return

    print("\nApplying...")
    n1 = await apply_mapping("wms_inventory", "country_of_origin", inv_country)
    n2 = await apply_mapping("wms_boxes", "country_of_origin", box_country)
    n3 = await apply_mapping("wms_receiving", "country_of_origin", rec_country)
    n4 = await apply_mapping("wms_inventory", "fabric_content", inv_fabric)
    n5 = await apply_mapping("wms_boxes", "fabric_content", box_fabric)
    n6 = await apply_mapping("wms_receiving", "fabric_content", rec_fabric)
    seeded = await seed_country_catalog()
    print(f"  wms_inventory.country_of_origin:  {n1} rows updated")
    print(f"  wms_boxes.country_of_origin:      {n2} rows updated")
    print(f"  wms_receiving.country_of_origin:  {n3} rows updated")
    print(f"  wms_inventory.fabric_content:     {n4} rows updated (whitespace only)")
    print(f"  wms_boxes.fabric_content:         {n5} rows updated (whitespace only)")
    print(f"  wms_receiving.fabric_content:     {n6} rows updated (whitespace only)")
    print(f"  wms_catalog_options seeded:       {seeded} new canonical countries")


asyncio.run(main())
