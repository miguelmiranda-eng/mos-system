"""Número de parte aduanal de las líneas de entrada (ASN/BPO).

Gramática (deducida de 218 líneas reales, 2026-09-15, cero excepciones):

    PREFIJO-[GÉNERO]PRENDA COMPOSICIÓN PAÍS [MS]
    GTS-SS100CCN      Goodie · manga corta (hombre) · 100 % algodón · China
    GTS-WLS58C42PHN   Goodie · mujer · manga larga · 58 C 42 P · Honduras
    AP-SS94M06SCHMS   (AP = Goodie histórico) · muestra

  · PREFIJO: por cliente. GTS = Goodie, SKT = Spektrum; AP fue otro prefijo de
    Goodie (solo se reconoce al LEER; nunca se genera). Los demás clientes
    reciben prefijo aquí porque nunca tuvieron código.
  · GÉNERO: hombre/adulto NO lleva letra (95 de 107 códigos reales); W mujer,
    B niño.
  · PRENDA: código corto (SS, LS, HO...). CW y MOCK son nuevos: crewneck y
    mock neck se recibían sin código (HO se usaba para cualquier sudadera).
  · COMPOSICIÓN: pares NN+letra de mayor a menor porcentaje. C algodón,
    P poliéster, N nylon, S spandex, R rayón, M modal.
  · PAÍS: ISO 2 letras derivado del país capturado. China = CN (decisión del
    usuario 2026-09-15; CH aparece en históricos de junio y solo se lee).
  · MS: sufijo de MUESTRA, por línea (1-3 piezas, nunca se reciben al almacén).

El número de parte NO codifica estilo, color ni talla: un código cubre todos
los estilos/colores/tallas con esa prenda, composición y origen. Por eso se
puede componer ANTES de que llegue el material, con lo que trae el packing
list, y el recibo lo hereda a cada caja al escanear el UPC (fase 2).

Este módulo es puro (sin base de datos) para poder probarlo solo. La
configuración editable vive en Mongo (wms_part_number_config) y se fusiona
sobre DEFAULT_CONFIG en routers/wms.py.
"""
from __future__ import annotations

import re
import unicodedata
from typing import Iterable

SAMPLE_SUFFIX = "MS"

DEFAULT_CONFIG: dict = {
    # cliente (como está en el catálogo curado) -> prefijo
    "customers": {
        "GOODIE TWO SLEEVES": "GTS",
        "SPEKTRUM": "SKT",
        "ROCK REBEL": "RRB",
        "SCREENWORKS": "SWK",
        "GTS TRACTOR": "GTT",
        "GTS BUCEES": "GTB",
        "LIVE & TELL": "LNT",
    },
    # prefijos que existen en códigos viejos y se aceptan al leer, mapeados al
    # cliente real. No se generan.
    "legacy_prefixes": {"AP": "GOODIE TWO SLEEVES"},
    # prendas: código, etiqueta para la UI y palabras que la delatan en la
    # descripción del packing list (en mayúsculas, sin acentos). El orden
    # importa: la primera que case gana, así que las más específicas van antes.
    "garments": [
        {"code": "MZHO", "label": "Sudadera con capucha y cierre", "keywords": ["CON DISPOSITIVO DE CIERRE Y CAPUCHA", "CON CIERRE Y CAPUCHA", "ZIP HOOD"]},
        {"code": "HO", "label": "Sudadera con capucha (sin cierre)", "keywords": ["CAPUCHA", "GORRO", "HOOD"]},
        {"code": "CW", "label": "Sudadera crewneck (sin capucha)", "keywords": ["SUDADERA", "CREWNECK", "CREW NECK", "SWEATSHIRT"]},
        {"code": "JK", "label": "Chamarra", "keywords": ["CHAMARRA", "ROMPEVIENTOS", "JACKET"]},
        {"code": "LG", "label": "Pantalón / leggings mujer", "keywords": ["LEGGING"]},
        {"code": "PANS", "label": "Pants", "keywords": ["PANS", "PANTALON", "PANTS", "JOGGER"]},
        {"code": "TANK", "label": "Top sin mangas / tank", "keywords": ["SIN MANGAS", "SIN MANGA", "TANK"]},
        {"code": "TOP", "label": "Top / sujetador", "keywords": ["SUJETADOR", "BLUSA", "TOP"]},
        {"code": "MOCK", "label": "Mock neck", "keywords": ["MOCK"]},
        {"code": "LS", "label": "Camiseta manga larga", "keywords": ["MANGA LARGA", "LONG SLEEVE"]},
        {"code": "SS", "label": "Camiseta manga corta", "keywords": ["MANGA CORTA", "SHORT SLEEVE", "CAMISETA", "T-SHIRT", "TEE"]},
    ],
    # género: letra que va ANTES de la prenda; hombre/adulto = sin letra
    "genders": [
        {"code": "", "label": "Hombre / adulto", "keywords": ["HOMBRE", "ADULTO", "MEN", "UNISEX"]},
        {"code": "W", "label": "Mujer", "keywords": ["MUJER", "DAMA", "WOMEN", "LADIES", "JUNIORS"]},
        {"code": "B", "label": "Niño", "keywords": ["NINO", "NINA", "JOVEN", "YOUTH", "KIDS", "INFANTIL"]},
    ],
    # fibra -> letra
    "fibers": [
        {"code": "C", "label": "Algodón", "keywords": ["ALGODON", "COTTON"]},
        {"code": "P", "label": "Poliéster", "keywords": ["POLIESTER", "POLYESTER", "POLI", "POLY"]},
        {"code": "N", "label": "Nylon", "keywords": ["NYLON", "NILON"]},
        {"code": "S", "label": "Spandex", "keywords": ["SPANDEX", "ESPANDEX", "ESPANDEZ", "ELASTANO", "ELASTANE", "LYCRA"]},
        {"code": "R", "label": "Rayón", "keywords": ["RAYON", "VISCOSA", "VISCOSE"]},
        {"code": "M", "label": "Modal", "keywords": ["MODAL"]},
    ],
    # país como se captura (nombre o ISO3) -> ISO2 del código
    "countries": {
        "CHINA": "CN", "CHN": "CN",
        "REPUBLICA DOMINICANA": "DO", "DOMINICAN REPUBLIC": "DO", "DOM": "DO",
        "HAITI": "HT", "HTI": "HT",
        "NICARAGUA": "NI", "NIC": "NI",
        "HONDURAS": "HN", "HND": "HN",
        "BANGLADESH": "BD", "BGD": "BD",
        "MEXICO": "MX", "MEX": "MX",
        "PAKISTAN": "PK", "PAK": "PK",
        "INDIA": "IN", "IND": "IN",
        "GUATEMALA": "GT", "GTM": "GT",
        "EL SALVADOR": "SV", "SLV": "SV",
        "VIETNAM": "VN", "VNM": "VN",
        "USA": "US", "ESTADOS UNIDOS": "US", "UNITED STATES": "US",
    },
    # tipos de operación (hoja INSTRUCTIONS del packing list)
    "import_types": ["Temporal", "Definitivo", "Retorno de MP", "Almacenaje", "Retrabajo", "Inspeccion"],
    # Descripciones capturables en la hoja de Entradas (desplegable, no texto
    # libre): la frase aduanal COMPLETA tal como viene en el packing list, con
    # composición, para que un solo pick proponga prenda + género + composición
    # y componga el número de parte. Lista inicial = las frases reales de las
    # entradas (2026-09-15), sin erratas. Editable desde la configuración del
    # módulo; se guardan en MAYÚSCULAS, espacios colapsados, sin duplicados
    # (comparadas sin acentos).
    "descriptions": [
        "CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 100% ALGODÓN",
        "CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 50% ALGODÓN, 50% POLIESTER",
        "CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 60% ALGODÓN, 40% POLIESTER",
        "CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 90% ALGODÓN, 10% POLIESTER",
        "CAMISETA MANGA CORTA PARA HOMBRE DE PUNTO 50% POLIESTER, 25% ALGODÓN, 25% RAYON",
        "CAMISETA MANGA LARGA PARA HOMBRE DE PUNTO 50% ALGODÓN, 50% POLIESTER",
        "CAMISETA SIN MANGAS PARA HOMBRE DE PUNTO 100% ALGODÓN",
        "CAMISETA MANGA CORTA PARA MUJER DE PUNTO 100% ALGODÓN",
        "CAMISETA MANGA CORTA PARA MUJER DE PUNTO 95% ALGODÓN, 5% SPANDEX",
        "CAMISETA MANGA CORTA PARA MUJER DE PUNTO 94% MODAL, 6% SPANDEX",
        "CAMISETA MANGA CORTA PARA MUJER DE PUNTO 50% POLIESTER, 25% ALGODÓN, 25% RAYON",
        "CAMISETA MANGA LARGA PARA MUJER DE PUNTO 58% ALGODÓN, 38% MODAL, 4% SPANDEX",
        "CAMISETA SIN MANGA PARA MUJER DE PUNTO 94% MODAL, 6% SPANDEX",
        "BLUSA SIN MANGA PARA MUJER DE PUNTO 95% MODAL, 5% SPANDEX",
        "CAMISETA MANGA CORTA PARA NIÑO DE PUNTO 100% ALGODÓN",
        "CAMISETA MANGA CORTA PARA NIÑO DE PUNTO 50% ALGODÓN, 50% POLIESTER",
        "CAMISETA MANGA CORTA PARA NIÑO DE PUNTO 90% ALGODÓN, 10% POLIESTER",
        "CAMISETA MANGA CORTA PARA NIÑO DE PUNTO 50% POLIESTER, 25% ALGODÓN, 25% RAYON",
        "SUDADERA SIN DISPOSITIVO DE CIERRE CON CAPUCHA PARA HOMBRE DE PUNTO 100% ALGODÓN",
        "SUDADERA SIN DISPOSITIVO DE CIERRE CON CAPUCHA PARA HOMBRE DE PUNTO 58% ALGODÓN, 42% POLIESTER",
        "SUDADERA SIN DISPOSITIVO DE CIERRE CON CAPUCHA PARA HOMBRE DE PUNTO 65% ALGODÓN, 35% POLIESTER",
        "SUDADERA SIN DISPOSITIVO DE CIERRE CON CAPUCHA PARA JOVEN DE PUNTO 60% ALGODÓN, 40% POLIESTER",
        "SUDADERA CON DISPOSITIVO DE CIERRE Y CAPUCHA PARA HOMBRE DE PUNTO 50% ALGODÓN, 50% POLIESTER",
        "SUDADERA SIN DISPOSITIVO DE CIERRE PARA HOMBRE DE PUNTO 58% ALGODÓN, 42% POLIESTER",
        "PANTALON PARA MUJER DE PUNTO 75% NYLON, 25% SPANDEX",
        "PANTALON PARA MUJER DE PUNTO 83% POLIESTER, 17% SPANDEX",
        "PANTALON PARA MUJER DE PUNTO 87% POLIESTER, 13% SPANDEX",
        "PANTALON PARA MUJER DE PUNTO 92% NYLON, 8% SPANDEX",
        "CHAMARRA PARA HOMBRE TIPO ROMPEVIENTOS CON CIERRE POR BROCHES 100% NYLON",
    ],
    # Composiciones capturables en la hoja de Entradas (desplegable, no texto
    # libre). Forma canónica = composition_text(): las fibras de arriba, de
    # mayor a menor porcentaje, suma 100. Lista inicial = las 34 composiciones
    # reales del inventario/catálogo curado (2026-09-15) + 4 de los códigos
    # históricos (90N10S, 94M06S, 58C38M04S, 75N25S). Editable desde la
    # configuración del módulo; el servidor valida con normalize_composition.
    "compositions": [
        "100% ALGODON", "100% POLIESTER", "100% NYLON",
        "99% ALGODON 1% POLIESTER", "98% ALGODON 2% POLIESTER",
        "95% ALGODON 5% POLIESTER", "95% ALGODON 5% SPANDEX",
        "94% MODAL 6% SPANDEX",
        "90% ALGODON 10% POLIESTER", "90% POLIESTER 10% ALGODON", "90% NYLON 10% SPANDEX",
        "83% ALGODON 17% POLIESTER",
        "80% ALGODON 20% POLIESTER", "80% POLIESTER 20% ALGODON",
        "75% ALGODON 25% POLIESTER", "75% NYLON 25% SPANDEX",
        "72% ALGODON 18% RAYON 10% POLIESTER",
        "70% ALGODON 30% POLIESTER", "70% ALGODON 15% POLIESTER 15% RAYON",
        "65% ALGODON 35% POLIESTER", "65% POLIESTER 35% ALGODON",
        "60% ALGODON 40% POLIESTER", "60% POLIESTER 40% ALGODON", "60% ALGODON 40% MODAL", "60% POLIESTER 40% RAYON",
        "58% ALGODON 42% POLIESTER", "58% POLIESTER 42% ALGODON", "58% ALGODON 38% MODAL 4% SPANDEX",
        "57% ALGODON 38% POLIESTER 5% SPANDEX",
        "55% ALGODON 45% POLIESTER", "55% POLIESTER 45% ALGODON",
        "54% ALGODON 46% POLIESTER",
        "52% ALGODON 48% POLIESTER", "52% ALGODON 48% MODAL", "52% ALGODON 43% POLIESTER 5% RAYON",
        "50% ALGODON 50% POLIESTER", "50% ALGODON 37% POLIESTER 13% RAYON", "50% POLIESTER 25% ALGODON 25% RAYON",
    ],
}


# ── utilidades ───────────────────────────────────────────────────────────────
def norm(s) -> str:
    """MAYÚSCULAS, sin acentos, espacios colapsados. Para comparar textos libres."""
    s = unicodedata.normalize("NFKD", str(s or ""))
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().upper()


def merge_config(stored: dict | None) -> dict:
    """DEFAULT_CONFIG con lo guardado encima. Los diccionarios se fusionan por
    llave (un cliente nuevo no borra los demás); las listas se reemplazan
    completas si vienen (así un admin puede reordenar prendas)."""
    cfg = {k: (dict(v) if isinstance(v, dict) else list(v)) for k, v in DEFAULT_CONFIG.items()}
    for k, v in (stored or {}).items():
        if k not in cfg:
            continue
        if isinstance(cfg[k], dict) and isinstance(v, dict):
            cfg[k].update({norm(a): str(b).strip().upper() if k != "legacy_prefixes" else norm(b) for a, b in v.items()})
            # Valor vacío = "quitar": así un admin puede retirar hasta un
            # cliente/país de fábrica desde el modal de configuración.
            cfg[k] = {a: b for a, b in cfg[k].items() if b}
        elif isinstance(cfg[k], list) and isinstance(v, list) and v:
            cfg[k] = v
    return cfg


def _by_code(items: Iterable[dict]) -> dict:
    return {str(i.get("code", "")).upper(): i for i in items}


# ── composición de fibras ────────────────────────────────────────────────────
# Porcentaje + el segmento de texto hasta el siguiente porcentaje: la fibra
# puede venir con calificativos antes ("20% RECYCLED POLYESTER", "100% COMBED
# COTTON", "100% RING-SPUN PRE-SHRUNK COTTON"), así que se busca DENTRO del
# segmento, no solo en la palabra pegada al %.
_PCT_RE = re.compile(r"(\d{1,3})\s*%\s*([^%\d]*)")


def parse_fibers(text, cfg: dict) -> tuple[list[tuple[int, str]], list[str]]:
    """'58% ALGODÓN, 42% POLIÉSTER' -> ([(58,'C'),(42,'P')], []).
    Devuelve (pares ordenados de mayor a menor, fibras que no reconoció)."""
    t = norm(text)
    fibers = cfg.get("fibers") or []
    pairs, unknown = [], []
    for pct, segment in _PCT_RE.findall(t):
        words = [w for w in re.findall(r"[A-Z]+", segment) if w != "DE"]
        code = None
        for word in words:
            for f in fibers:
                if any(word.startswith(norm(k)) or norm(k).startswith(word) for k in f.get("keywords", [])):
                    code = str(f["code"]).upper()
                    break
            if code:
                break
        if code:
            pairs.append((int(pct), code))
        elif words:
            unknown.append(" ".join(words))
    # La misma fibra dos veces ("10% POLYESTER 10% RECYCLED POLYESTER") se
    # suma: para aduana es una sola fibra (80C20P, no 80C10P10P).
    merged: dict[str, int] = {}
    for pct, code in pairs:
        merged[code] = merged.get(code, 0) + pct
    pairs = [(pct, code) for code, pct in merged.items()]
    # mayor a menor; a igual porcentaje respeta el orden de captura
    pairs.sort(key=lambda p: -p[0])
    return pairs, unknown


def composition_code(pairs: list[tuple[int, str]]) -> str:
    """[(58,'C'),(42,'P')] -> '58C42P'; [(100,'C')] -> '100C'."""
    return "".join(f"{p:02d}{c}" if p < 100 else f"{p}{c}" for p, c in pairs)


def composition_text(pairs: list[tuple[int, str]], cfg: dict) -> str:
    """Forma canónica para guardar como fabric_content: '58% ALGODON 42% POLIESTER'."""
    labels = {str(f["code"]).upper(): norm(f.get("label", f["code"])) for f in cfg.get("fibers") or []}
    return " ".join(f"{p}% {labels.get(c, c)}" for p, c in pairs)


def normalize_composition(text, cfg: dict) -> dict:
    """Valida una composición del CATÁLOGO (pestaña Composiciones) y la deja
    canónica. A diferencia de parse_fibers (que tolera lo que traiga el
    packing list), aquí se exige: al menos una fibra, todas reconocidas y
    suma exacta de 100 (la misma fibra repetida ya viene sumada). Devuelve
    {'ok', 'text', 'code', 'errors'}."""
    pairs, unknown = parse_fibers(text, cfg)
    errors = []
    if unknown:
        errors.append(f"fibra no reconocida: {', '.join(unknown)}")
    if not pairs and not unknown:
        errors.append("sin porcentajes (ej. 60% ALGODON 40% POLIESTER)")
    total = sum(p for p, _ in pairs)
    if pairs and total != 100:
        errors.append(f"suma {total}%, debe ser 100%")
    if errors:
        return {"ok": False, "text": norm(text), "code": "", "errors": errors}
    return {"ok": True, "text": composition_text(pairs, cfg), "code": composition_code(pairs), "errors": []}


# ── lectura de la descripción ────────────────────────────────────────────────
def parse_description(desc, cfg: dict) -> dict:
    """Propone prenda, género y composición a partir del texto del packing
    list. Devuelve {'garment', 'gender', 'fibers', 'unknown_fibers'}; lo que
    no reconoce va vacío para que la persona lo elija."""
    t = norm(desc)
    garment = ""
    for g in cfg.get("garments") or []:
        if any(norm(k) in t for k in g.get("keywords", [])):
            garment = str(g["code"]).upper()
            break
    gender = ""
    for g in cfg.get("genders") or []:
        if str(g.get("code", "")) and any(norm(k) in t for k in g.get("keywords", [])):
            gender = str(g["code"]).upper()
            break
    pairs, unknown = parse_fibers(t, cfg)
    # Pantalón de mujer siempre se codificó LG (leggings); PANS es de hombre.
    if garment == "PANS" and gender == "W":
        garment = "LG"
    return {"garment": garment, "gender": gender, "fibers": pairs, "unknown_fibers": unknown}


# ── compositor ───────────────────────────────────────────────────────────────
def country_code(country, cfg: dict) -> str:
    c = norm(country)
    if not c:
        return ""
    table = cfg.get("countries") or {}
    if c in table:
        return str(table[c]).upper()
    if len(c) == 2 and c.isalpha():
        return c  # ya viene como ISO2
    return ""


def compose(customer, garment, gender, composition, country, sample=False, cfg: dict | None = None) -> dict:
    """Arma el número de parte. `composition` puede ser texto ('100% algodón')
    o lista de pares [(100,'C')]. Devuelve {'part_number', 'ok', 'errors',
    'composition_code', 'country_code', 'prefix'}; con errores part_number=''."""
    cfg = cfg or DEFAULT_CONFIG
    errors = []
    prefix = (cfg.get("customers") or {}).get(norm(customer), "")
    if not prefix:
        errors.append(f"cliente sin prefijo: '{customer}'")
    gcode = str(garment or "").upper().strip()
    if gcode not in _by_code(cfg.get("garments") or []):
        errors.append(f"prenda no reconocida: '{garment}'")
    gen = str(gender or "").upper().strip()
    if gen not in {str(g.get("code", "")).upper() for g in cfg.get("genders") or []}:
        errors.append(f"género no reconocido: '{gender}'")
    if isinstance(composition, str):
        pairs, unknown = parse_fibers(composition, cfg)
        if unknown:
            errors.append(f"fibra no reconocida: {', '.join(unknown)}")
    else:
        pairs = [(int(p), str(c).upper()) for p, c in (composition or [])]
        pairs.sort(key=lambda p: -p[0])
    if not pairs:
        errors.append("composición vacía")
    elif sum(p for p, _ in pairs) != 100:
        errors.append(f"la composición suma {sum(p for p, _ in pairs)}%, no 100%")
    ccode = country_code(country, cfg)
    if not ccode:
        errors.append(f"país sin código de 2 letras: '{country}'")
    comp = composition_code(pairs) if pairs else ""
    pn = f"{prefix}-{gen}{gcode}{comp}{ccode}{SAMPLE_SUFFIX if sample else ''}" if not errors else ""
    return {"part_number": pn, "ok": not errors, "errors": errors,
            "composition_code": comp, "country_code": ccode, "prefix": prefix}


# ── modo estricto de captura ─────────────────────────────────────────────────
# Composición y país FORMAN el número de parte: si entran fuera del catálogo la
# línea queda sin código y el error aparece hasta el recibo (match-line none →
# nadie recibe). Estos predicados se evalúan al capturar para atajarlo ahí. La
# descripción NO se valida (es texto aduanal, no entra al código).
def composition_in_catalog(text, cfg: dict) -> dict:
    """{'ok', 'why'}: la composición parsea (fibras conocidas, suma 100) Y su
    código está entre las del catálogo `compositions`. Vacía → ok (la
    obligatoriedad la decide quien captura, no este predicado)."""
    if not str(text or "").strip():
        return {"ok": True, "why": ""}
    r = normalize_composition(text, cfg)
    if not r["ok"]:
        return {"ok": False, "why": "; ".join(r["errors"])}
    known = {normalize_composition(c, cfg)["code"] for c in cfg.get("compositions") or []}
    if r["code"] not in known:
        return {"ok": False, "why": "no está en el catálogo (Configuración → Composiciones)"}
    return {"ok": True, "why": ""}


def country_in_catalog(country, cfg: dict) -> dict:
    """{'ok', 'why'}: el país está en la tabla `countries` (nombre o ISO3) o es
    uno de sus códigos de 2 letras. `country_code` acepta cualquier ISO2 con
    tal de componer; aquí un 'XX' suelto se rechaza. Vacío → ok."""
    c = norm(country)
    if not c:
        return {"ok": True, "why": ""}
    table = cfg.get("countries") or {}
    if c in table or c in {str(v).upper() for v in table.values()}:
        return {"ok": True, "why": ""}
    return {"ok": False, "why": "no está en el catálogo (Configuración → Países)"}


_PARSE_RE = re.compile(r"^([A-Z]{2,4})-([A-Z]*?)(\d[\dA-Z]*?[A-Z])([A-Z]{2})(MS)?$")


def parse_part_number(pn, cfg: dict | None = None) -> dict | None:
    """Descompone un código existente (también los históricos AP-…/…CH).
    Devuelve None si no sigue la gramática."""
    cfg = cfg or DEFAULT_CONFIG
    m = _PARSE_RE.match(norm(pn).replace(" ", ""))
    if not m:
        return None
    prefix, gg, comp, cc, ms = m.groups()
    genders = {str(g.get("code", "")).upper() for g in cfg.get("genders") or []} - {""}
    garments = _by_code(cfg.get("garments") or [])
    gender, garment = "", gg
    if gg and gg[0] in genders and gg[1:] in garments:
        gender, garment = gg[0], gg[1:]
    if garment not in garments:
        return None
    pairs = [(int(p), c) for p, c in re.findall(r"(\d{2,3})([A-Z])", comp)]
    customers = {v: k for k, v in (cfg.get("customers") or {}).items()}
    customer = customers.get(prefix) or (cfg.get("legacy_prefixes") or {}).get(prefix, "")
    return {"prefix": prefix, "customer": customer, "gender": gender, "garment": garment,
            "fibers": pairs, "country_code": cc, "sample": bool(ms)}
