"""Pruebas del compositor de número de parte (services/part_number.py).

Puro: no toca la base. Corre con `python backend/tests/test_part_number.py`
o con pytest.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.part_number import (  # noqa: E402
    DEFAULT_CONFIG, compose, parse_description, parse_fibers, composition_code,
    parse_part_number, merge_config, country_code, normalize_composition, composition_text,
)

ok = fail = 0


def check(nombre, cond, detalle=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"   PASS  {nombre}")
    else:
        fail += 1
        print(f"   FAIL  {nombre}  {detalle}")


def run():
    C = DEFAULT_CONFIG
    print("== 1. Composición de fibras")
    p, u = parse_fibers("CAMISETA PARA HOMBRE MANGA CORTA DE PUNTO 100% ALGODÓN", C)
    check("100% algodón -> 100C", composition_code(p) == "100C" and not u, (p, u))
    p, _ = parse_fibers("58% ALGODÓN, 42% POLIÉSTER", C)
    check("58/42 -> 58C42P", composition_code(p) == "58C42P", p)
    p, _ = parse_fibers("42% POLIESTER 58% ALGODON", C)
    check("orden mayor→menor aunque venga al revés", composition_code(p) == "58C42P", p)
    p, _ = parse_fibers("50% POLIESTER, 25% ALGODÓN, 25% RAYÓN", C)
    check("tres fibras -> 50P25C25R", composition_code(p) == "50P25C25R", p)
    p, _ = parse_fibers("58% ALGODÓN 38% MODAL 4% SPANDEX", C)
    check("4% se escribe 04 -> 58C38M04S", composition_code(p) == "58C38M04S", p)
    p, _ = parse_fibers("90% NILON, 10% ESPANDEX", C)
    check("nilon/espandex -> 90N10S", composition_code(p) == "90N10S", p)
    p, u = parse_fibers("60% COTTON 40% POL", C)
    check("inglés y abreviado -> 60C40P", composition_code(p) == "60C40P" and not u, (p, u))
    p, u = parse_fibers("100% BAMBOO", C)
    check("fibra desconocida se reporta", u == ["BAMBOO"], u)

    print("\n== 2. Lectura de la descripción")
    d = parse_description("CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 100% ALGODÓN", C)
    check("manga corta hombre", d["garment"] == "SS" and d["gender"] == "", d)
    d = parse_description("CAMISETA MANGA CORTA PARA NIÑO DE PUNTO 100% ALGODON", C)
    check("niño -> B", d["gender"] == "B" and d["garment"] == "SS", d)
    d = parse_description("CAMISETA MANGA LARGA PARA MUJER DE PUNTO 58% ALGODÓN 38% MODAL 4% SPANDEX", C)
    check("mujer manga larga", d["gender"] == "W" and d["garment"] == "LS", d)
    d = parse_description("SUDADERA SIN DISPOSITIVO DE CIERRE CON CAPUCHA PARA HOMBRE DE PUNTO 58% ALGODÓN, 42% POLIÉSTER", C)
    check("con capucha sin cierre -> HO", d["garment"] == "HO", d)
    d = parse_description("SUDADERA CON DISPOSITIVO DE CIERRE Y CAPUCHA PARA HOMBRE DE PUNTO 50% ALGODON 50% POLIESTER", C)
    check("con capucha y cierre -> MZHO", d["garment"] == "MZHO", d)
    d = parse_description("SUDADERA SIN DISPOSITIVO DE CIERRE PARA HOMBRE DE PUNTO 58% ALGODÓN, 42% POLIÉSTER", C)
    check("sudadera sin capucha -> CW (nuevo, antes se codificaba HO)", d["garment"] == "CW", d)
    d = parse_description("PANTALON PARA MUJER DE PUNTO 75% NYLON, 25% SPANDEX", C)
    check("pantalón mujer -> LG + W (así se codificó siempre; PANS es de hombre)", d["garment"] == "LG" and d["gender"] == "W", d)
    d = parse_description("PANS PARA HOMBRE 100% ALGODÓN DE PUNTO", C)
    check("pants hombre -> PANS", d["garment"] == "PANS" and d["gender"] == "", d)
    p, u = parse_fibers("75% NILON, 25% ESPANDEZ", C)
    check("typo real ESPANDEZ -> S", composition_code(p) == "75N25S" and not u, (p, u))
    d = parse_description("TOP SIN MANGAS PARA MUJER DE PUNTO 90% NILON, 10% ESPANDEX", C)
    check("sin mangas -> TANK", d["garment"] == "TANK", d)
    d = parse_description("SUJETADOR DE TIRANTES PARA MUJER DE PUNTO 75% NILON, 25% ESPANDEX", C)
    check("sujetador -> TOP", d["garment"] == "TOP", d)
    d = parse_description("CHAMARRA PARA HOMBRE TIPO ROMPEVIENTOS CON CIERRE POR BROCHE 100% NYLON", C)
    check("chamarra -> JK", d["garment"] == "JK", d)
    d = parse_description("", C)
    check("vacío no propone nada", d["garment"] == "" and d["gender"] == "" and not d["fibers"])

    print("\n== 3. Compositor")
    r = compose("GOODIE TWO SLEEVES", "SS", "", "100% ALGODON", "CHINA")
    check("GTS-SS100CCN (China = CN)", r["part_number"] == "GTS-SS100CCN", r)
    r = compose("Goodie Two Sleeves", "LS", "W", "58% ALGODÓN 42% POLIÉSTER", "HND")
    check("GTS-WLS58C42PHN (país ISO3, cliente en minúsculas)", r["part_number"] == "GTS-WLS58C42PHN", r)
    r = compose("SPEKTRUM", "SS", "", [(100, "C")], "MEXICO")
    check("SKT-SS100CMX (composición ya parseada)", r["part_number"] == "SKT-SS100CMX", r)
    r = compose("GOODIE TWO SLEEVES", "SS", "", "94% MODAL 6% SPANDEX", "CHINA", sample=True)
    check("muestra -> sufijo MS", r["part_number"] == "GTS-SS94M06SCNMS", r)
    r = compose("ROCK REBEL", "HO", "", "50% ALGODON 50% POLIESTER", "NICARAGUA")
    check("prefijo nuevo RRB", r["part_number"] == "RRB-HO50C50PNI", r)
    r = compose("SCREENWORKS", "SS", "B", "100% COTTON", "HAITI")
    check("prefijo nuevo SWK + niño", r["part_number"] == "SWK-BSS100CHT", r)
    r = compose("CLIENTE X", "SS", "", "100% ALGODON", "CHINA")
    check("cliente sin prefijo -> error, sin código", not r["ok"] and r["part_number"] == "" and "prefijo" in r["errors"][0], r)
    r = compose("GOODIE TWO SLEEVES", "SS", "", "60% ALGODON 30% POLIESTER", "CHINA")
    check("composición que no suma 100 -> error", not r["ok"] and "suma 90" in r["errors"][0], r)
    r = compose("GOODIE TWO SLEEVES", "SS", "", "100% ALGODON", "ATLANTIS")
    check("país desconocido -> error", not r["ok"] and "país" in r["errors"][0], r)
    r = compose("GOODIE TWO SLEEVES", "SS", "", "100% BAMBOO", "CHINA")
    check("fibra desconocida -> error", not r["ok"] and "fibra" in r["errors"][0], r)
    check("country_code acepta ISO2 directo", country_code("cn", C) == "CN")

    print("\n== 4. Lectura de códigos existentes (históricos)")
    p = parse_part_number("GTS-SS100CCN")
    check("GTS-SS100CCN", p and p["customer"] == "GOODIE TWO SLEEVES" and p["garment"] == "SS" and p["gender"] == "" and p["fibers"] == [(100, "C")] and p["country_code"] == "CN" and not p["sample"], p)
    p = parse_part_number("AP-SS94M06SCHMS")
    check("AP histórico -> Goodie, CH se lee, MS muestra", p and p["customer"] == "GOODIE TWO SLEEVES" and p["country_code"] == "CH" and p["sample"] and p["fibers"] == [(94, "M"), (6, "S")], p)
    p = parse_part_number("GTS-WTANK90N10SCNMS")
    check("WTANK -> mujer + tank", p and p["gender"] == "W" and p["garment"] == "TANK", p)
    p = parse_part_number("GTS-MZHO50C50PHN")
    check("MZHO no se confunde con género M", p and p["gender"] == "" and p["garment"] == "MZHO", p)
    p = parse_part_number("SKT-PANS100CCN")
    check("PANS", p and p["garment"] == "PANS", p)
    check("no gramática -> None", parse_part_number("5000") is None and parse_part_number("GT20461J1358") is None and parse_part_number("CL-1001") is None)

    print("\n== 5. merge_config")
    m = merge_config({"customers": {"nuevo cliente": "nvc"}, "countries": {"Perú": "pe"}})
    check("cliente nuevo se suma sin borrar los demás", m["customers"]["NUEVO CLIENTE"] == "NVC" and m["customers"]["GOODIE TWO SLEEVES"] == "GTS")
    check("país nuevo normalizado", m["countries"]["PERU"] == "PE")
    m = merge_config({"garments": []})
    check("lista vacía no reemplaza", len(m["garments"]) == len(C["garments"]))
    m = merge_config({"customers": {"GTS BUCEES": ""}})
    check("valor vacío retira un cliente de fábrica", "GTS BUCEES" not in m["customers"] and "GOODIE TWO SLEEVES" in m["customers"])

    print("\n== 6. Catálogo de composiciones (normalize_composition)")
    r = normalize_composition("60% COTTON / 40% POLY", C)
    check("inglés y separadores -> canónica", r["ok"] and r["text"] == "60% ALGODON 40% POLIESTER" and r["code"] == "60C40P", r)
    r = normalize_composition("42% poliéster 58% algodón", C)
    check("reordena mayor→menor", r["ok"] and r["text"] == "58% ALGODON 42% POLIESTER", r)
    r = normalize_composition("67% COTTON 38% POLYESTER 5% SPANDEX", C)
    check("no suma 100 -> error", not r["ok"] and any("110%" in e for e in r["errors"]), r)
    r = normalize_composition("60% COTTON 40% BAMBOO", C)
    check("fibra desconocida -> error con nombre", not r["ok"] and "BAMBOO" in r["errors"][0], r)
    r = normalize_composition("80% COTTON 10% POLYESTER 10% RECYCLED POLYESTER", C)
    check("fibra repetida se suma (reciclado = poliéster)", r["ok"] and r["code"] == "80C20P" and r["text"] == "80% ALGODON 20% POLIESTER", r)
    r = normalize_composition("100% RING-SPUN PRE-SHRUNK COMBED COTTON", C)
    check("calificativos antes de la fibra no estorban", r["ok"] and r["code"] == "100C", r)
    p, u = parse_fibers("CAMISETA 100% ALGODÓN PEINADO", C)
    check("compositor: calificativo después tampoco", composition_code(p) == "100C" and not u, (p, u))
    r = normalize_composition("ALGODON", C)
    check("sin porcentajes -> error", not r["ok"], r)
    bad = [c for c in C["compositions"] if not normalize_composition(c, C)["ok"]]
    check("todas las composiciones de fábrica son válidas", not bad, bad)
    noncanon = [c for c in C["compositions"] if normalize_composition(c, C)["text"] != c]
    check("todas las de fábrica ya están en forma canónica", not noncanon, noncanon)
    codes = [normalize_composition(c, C)["code"] for c in C["compositions"]]
    check("sin duplicados por código", len(codes) == len(set(codes)))
    check("la canónica compone el mismo código que el texto crudo",
          composition_code(parse_fibers("58% ALGODÓN 38% MODAL 4% SPANDEX", C)[0]) == normalize_composition("58% ALGODON 38% MODAL 4% SPANDEX", C)["code"] == "58C38M04S")
    m = merge_config({"compositions": ["100% ALGODON"]})
    check("merge_config reemplaza la lista completa", m["compositions"] == ["100% ALGODON"] and composition_text(parse_fibers("100% ALGODON", m)[0], m) == "100% ALGODON")

    print("\n== 7. Catálogo de descripciones (cada una debe componer)")
    bad = []
    for d in C["descriptions"]:
        p = parse_description(d, C)
        comp = normalize_composition(d, C)
        if not p["garment"] or not comp["ok"]:
            bad.append((d, p["garment"], comp["errors"]))
    check("todas las descripciones de fábrica proponen prenda y composición válida", not bad, bad)
    p = parse_description("CAMISETA MANGA CORTA PARA MUJER DE PUNTO 94% MODAL, 6% SPANDEX", C)
    check("mujer + modal/spandex", p["gender"] == "W" and composition_code(p["fibers"]) == "94M06S", p)
    p = parse_description("SUDADERA SIN DISPOSITIVO DE CIERRE CON CAPUCHA PARA JOVEN DE PUNTO 60% ALGODÓN, 40% POLIESTER", C)
    check("joven → niño (B), capucha → HO", p["gender"] == "B" and p["garment"] == "HO", p)
    keys = [d.upper() for d in C["descriptions"]]
    check("sin duplicados", len(keys) == len(set(keys)))

    print(f"\n===== {ok} PASS / {fail} FAIL =====")
    return fail


def test_part_number():
    assert run() == 0


if __name__ == "__main__":
    sys.exit(1 if run() else 0)
