"""One-off: consolidate typo'd country_of_origin values across wms_inventory
+ wms_receiving. Builds a mapping with difflib similarity to a canonical list,
prints the plan, and applies it after confirmation via the APPLY env var."""
import asyncio
import difflib
import os
import re
from collections import Counter

from dotenv import load_dotenv
from pathlib import Path

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env")

from deps import db  # noqa: E402

# Canonical names — the spellings we want to keep.
CANONICAL = [
    "BANGLADESH",
    "PAKISTAN",
    "NICARAGUA",
    "REPUBLICA DOMINICANA",
    "DOMINICAN REPUBLIC",
    "HAITI",
    "HONDURAS",
    "CHINA",
    "MEXICO",
    "EL SALVADOR",
    "INDIA",
    "GUATEMALA",
    "USA",
    "ESTADOS UNIDOS",
    "VIETNAM",
    "CAMBODIA",
    "INDONESIA",
    "PERU",
    "COLOMBIA",
    "PHILIPPINES",
    "TURKEY",
    "EGYPT",
    "JORDAN",
    "ETHIOPIA",
]

# Hard-coded overrides for cases similarity won't catch confidently.
MANUAL = {
    "REP DOMINICANA": "REPUBLICA DOMINICANA",
    "REP, DOMINICANA": "REPUBLICA DOMINICANA",
    "REP,DOMINICANA": "REPUBLICA DOMINICANA",
    "RD": "REPUBLICA DOMINICANA",
    "REP DOM": "REPUBLICA DOMINICANA",
    "DOMINICANA": "REPUBLICA DOMINICANA",
    "DOMINICAQNA": "REPUBLICA DOMINICANA",
    "REPUBLICA DOMINICANAREPUBLICA DOMINICANA": "REPUBLICA DOMINICANA",
    "SALVADOR": "EL SALVADOR",
    "SALBADOR": "EL SALVADOR",
    "SALVADAR": "EL SALVADOR",
    "SALIVADOR": "EL SALVADOR",
    "MADE IN CHINA": "CHINA",
    "RING-SPUN COTTON": None,
    "WASH COLD": None,
    "WASH": None,
    ".23": None,
    "0": None,
}

# Pure-junk regex: only fires when the value is dominated by percentages/symbols,
# NOT when a country name has a stray digit suffix (those should be merged).
JUNK_REGEX = re.compile(r"%|/|,")
DIGIT_SUFFIX_REGEX = re.compile(r"^([A-Z ]+?)\d+$")  # "PAKISTAN24" -> "PAKISTAN"

SIMILARITY_THRESHOLD = 0.78


def strip_digit_suffix(value: str) -> str:
    """Return the value with any trailing digits removed, so 'PAKISTAN24'
    matches the canonical 'PAKISTAN' under difflib."""
    m = DIGIT_SUFFIX_REGEX.match(value)
    return m.group(1).strip() if m else value


def best_match(value: str):
    """Return (canonical, score) or (None, 0) if no good fit."""
    matches = difflib.get_close_matches(value, CANONICAL, n=1, cutoff=SIMILARITY_THRESHOLD)
    if not matches:
        return None, 0.0
    score = difflib.SequenceMatcher(None, value, matches[0]).ratio()
    return matches[0], score


async def main():
    apply = os.environ.get("APPLY") == "1"

    # 1. Gather all distinct values + counts from both collections.
    counts: Counter[str] = Counter()
    for coll_name in ("wms_inventory", "wms_receiving"):
        coll = getattr(db, coll_name)
        cursor = coll.aggregate([
            {"$match": {"country_of_origin": {"$ne": None, "$nin": ["", "."]}}},
            {"$group": {"_id": "$country_of_origin", "count": {"$sum": 1}}},
        ])
        async for d in cursor:
            v = (d.get("_id") or "").strip()
            if v:
                counts[v] += int(d.get("count", 0))

    # 2. Build the mapping.
    plan = []  # (original, target_or_None, source_label, score)
    untouched = []
    for value, count in counts.most_common():
        upper = value.upper().strip()
        if upper in CANONICAL:
            continue  # already canonical, leave alone

        if upper in MANUAL:
            plan.append((value, MANUAL[upper], "manual", 1.0, count))
            continue

        # Try similarity FIRST so "PAKISTAN24" -> "PAKISTAN" wins over junk.
        candidate = strip_digit_suffix(upper)
        match, score = best_match(candidate)
        if match:
            plan.append((value, match, f"similar({score:.2f})", score, count))
            continue

        if JUNK_REGEX.search(value):
            plan.append((value, None, "junk-regex", 0.0, count))
            continue

        untouched.append((value, count))

    # 3. Print the plan.
    print(f"\n=== PLAN ({'APPLY' if apply else 'DRY RUN'}) ===")
    print(f"Total distinct non-canonical values: {len(plan) + len(untouched)}")
    print(f"  - To merge into canonical:   {sum(1 for p in plan if p[1])}")
    print(f"  - To clear (junk):           {sum(1 for p in plan if p[1] is None)}")
    print(f"  - Left untouched (no match): {len(untouched)}")
    print()
    print("MERGES (top 60 by row count):")
    print(f"  {'OLD':<35} -> {'NEW':<25}  {'src':<14} rows")
    merges = sorted([p for p in plan if p[1]], key=lambda p: -p[4])
    for old, new, src, score, count in merges[:60]:
        print(f"  {old[:33]:<35} -> {new[:23]:<25}  {src:<14} {count}")
    if len(merges) > 60:
        print(f"  ... and {len(merges) - 60} more")
    print()
    clears = [p for p in plan if p[1] is None]
    if clears:
        print(f"CLEARS ({len(clears)}):")
        for old, _, src, _, count in clears:
            print(f"  '{old}' ({src}, {count} rows) -> ''")
    print()
    if untouched:
        print(f"LEFT UNTOUCHED ({len(untouched)}) — review manually:")
        for v, c in untouched[:30]:
            print(f"  '{v}' ({c} rows)")
        if len(untouched) > 30:
            print(f"  ... and {len(untouched) - 30} more")

    if not apply:
        print("\nDRY RUN — re-run with `APPLY=1` to execute.")
        return

    # 4. Apply.
    print("\n=== APPLYING ===")
    total_modified = 0
    for old, new, _, _, _ in plan:
        for coll_name in ("wms_inventory", "wms_receiving"):
            coll = getattr(db, coll_name)
            res = await coll.update_many(
                {"country_of_origin": old},
                {"$set": {"country_of_origin": (new or "")}},
            )
            total_modified += res.modified_count
    print(f"Total rows updated: {total_modified}")


if __name__ == "__main__":
    asyncio.run(main())
