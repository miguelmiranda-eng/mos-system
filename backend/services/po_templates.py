"""Motor de plantillas de PDF: leer el work order de un cliente NUEVO sin escribir codigo.

PARA QUE ES
───────────
Hoy cada formato de PO vive como regex dentro de `printavo_export.py`: Goodie en
`_parse_goodie_page`, Culture Kings en `_parse_culturekings_text`. Agregar un
cliente significaba editar ese archivo. Aqui una plantilla es DATO: dice donde
esta cada campo dentro del PDF, y el motor la ejecuta.

QUE NO HACE
───────────
No reemplaza a Goodie ni a Spektrum. Esos dos llevan meses corriendo, estan
cubiertos por `tests/smoke_po_golden.py` (137 POs reales) y migrarlos solo
agregaria riesgo. El orden de intento es: Goodie -> Spektrum -> plantillas. Las
plantillas son para lo que viene.

UNA PAGINA = UN ESTILO
──────────────────────
Decision del usuario 2026-10-06. El motor recorre pagina por pagina y cada una
que pase la huella produce UN registro. Un PDF de 5 hojas da 5 estilos.

SIN IA
──────
El mapeo son reglas guardadas que un humano señalo con el mouse; la lectura es
deterministica. Ver memoria `printavo-pdf-sin-ia`.

VOCABULARIO
───────────
Cada campo se describe con un dict {"tipo": ..., ...}. Son pocos a proposito: lo
que el mapeador visual pueda generar con clics, ni mas ni menos.

  fijo          valor constante                  {"tipo":"fijo","valor":"ACME"}
  derecha_de    a la derecha de un rotulo,       {"tipo":"derecha_de","rotulo":"PO #",
                en el mismo renglon               "hasta":"DATE"}
  despues_de    "Rotulo: valor" (resto del       {"tipo":"despues_de","rotulo":"Color:"}
                renglon)
  debajo_de     celda bajo un encabezado de      {"tipo":"debajo_de","rotulo":"CUST PO",
                tabla, acotada por el de al lado  "limite":"BLANK PO"}
  patron        escape hatch: expresion regular  {"tipo":"patron","patron":"...","grupo":1}
  rejilla       tallas: rotulo de tallas +       {"tipo":"rejilla","rotulo_tallas":"SIZE",
                rotulo de cantidades              "rotulo_cantidades":"QTY"}

Los de posicion (`derecha_de`, `debajo_de`, `rejilla`) trabajan sobre las
palabras y sus coordenadas, NO sobre coordenadas absolutas guardadas: se anclan
al rotulo. Asi el mapeo sobrevive a que el cliente mueva el bloque de lugar o
cambie el numero de renglones.
"""
import re

# Un rotulo y el contenido de su renglon no caen exactamente en la misma Y: en
# los tickets medidos difieren ~4.5pt, y el renglon vecino esta a >=13pt. 8 cae
# comodo en medio. Misma constante y misma razon que en printavo_export.
TOL_RENGLON = 8

# Cuanto puede desalinearse horizontalmente una cantidad respecto de su talla
# antes de considerarla de otra columna.
TOL_COLUMNA = 18

# Separacion maxima entre dos palabras del MISMO valor, en proporcion al alto de
# la letra: un espacio mide ~0.3 em y el hueco entre columnas casi siempre pasa
# de 1 em. "CULTURE KINGS" (titulo grande) va a 4.9pt con letra de ~16pt.
HUECO_PALABRA_EM = 0.6


class Pagina:
    """Lo que el motor necesita de una pagina, calculado UNA vez.

    `page.extract_words()` es la llamada cara de pdfplumber; varios campos de la
    misma plantilla la pedirian otra vez. Se cachea aqui."""

    def __init__(self, page):
        self.page = page
        self.texto = page.extract_text() or ""
        self.lineas = self.texto.split("\n")
        self.palabras = page.extract_words()

    def palabras_de_renglon(self, top, tol=TOL_RENGLON):
        return [w for w in self.palabras if abs(w["top"] - top) <= tol]

    def buscar_rotulo(self, rotulo, ocurrencia=0):
        """Aparicion N de un rotulo (una o varias palabras seguidas).

        Devuelve (x0, x1, top) o None. Compara sin acentos ni mayusculas y
        admite que pdfplumber parta el rotulo en varias palabras: "CUST PO" puede
        venir como ["CUST","PO"] o como ["CUST PO"].

        `ocurrencia` existe porque el mismo texto aparece varias veces en una hoja
        y quedarse con la primera elige la equivocada: en estos tickets "CUST"
        esta tanto en el encabezado del cliente como en la columna "CUST PO" de
        la tabla. El mapeador SABE cual señalo el usuario, asi que lo guarda en la
        regla y aqui se respeta. Si esa aparicion ya no existe (el PDF cambio),
        se cae a la primera en vez de no devolver nada."""
        objetivo = _norm(rotulo)
        if not objetivo:
            return None
        partes = objetivo.split()
        hallazgos = []
        for i, w in enumerate(self.palabras):
            if _norm(w["text"]) != partes[0]:
                continue
            x0, x1, top = w["x0"], w["x1"], w["top"]
            ok = True
            for j, parte in enumerate(partes[1:], start=1):
                if i + j >= len(self.palabras):
                    ok = False
                    break
                sig = self.palabras[i + j]
                # La continuacion tiene que ir en el MISMO renglon y a la derecha.
                if abs(sig["top"] - top) > TOL_RENGLON or _norm(sig["text"]) != parte:
                    ok = False
                    break
                x1 = sig["x1"]
            if ok:
                hallazgos.append((x0, x1, top))
        if not hallazgos:
            return None
        return hallazgos[ocurrencia] if 0 <= ocurrencia < len(hallazgos) else hallazgos[0]


def _norm(s):
    """Minusculas, sin acentos y con los espacios colapsados."""
    import unicodedata
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s.strip().lower())


# ── Primitivas ───────────────────────────────────────────────────────────────

def _fijo(pag, spec):
    return spec.get("valor")


def _derecha_de(pag, spec):
    """Valor a la derecha de un rotulo, en su mismo renglon.

    `hasta` corta cuando el renglon sigue con OTRO rotulo: en el ticket de Goodie
    el renglon dice "CUSTOMER MEIJER ISSUE DATE 18-SEP-26" y sin el corte se
    traeria tambien "ISSUE DATE 18-SEP-26"."""
    pos = pag.buscar_rotulo(spec.get("rotulo", ""), spec.get("ocurrencia", 0))
    if not pos:
        return None
    _, x1, top = pos
    corte = None
    if spec.get("hasta"):
        fin = pag.buscar_rotulo(spec["hasta"])
        if fin and abs(fin[2] - top) <= TOL_RENGLON and fin[0] > x1:
            corte = fin[0]
    out = [w for w in pag.palabras_de_renglon(top)
           if w["x0"] >= x1 and (corte is None or w["x1"] <= corte)]
    out.sort(key=lambda w: w["x0"])
    return " ".join(w["text"] for w in out).strip() or None


def _despues_de(pag, spec):
    """'Rotulo: valor' — el resto del renglon de texto. Para PDFs tipo formulario
    (Culture Kings) donde el dato va pegado a su etiqueta."""
    rot = re.escape(spec.get("rotulo", ""))
    m = re.search(rf"^\s*{rot}\s*(.+)$", pag.texto, re.I | re.M)
    return m.group(1).strip() if m else None


def _debajo_de(pag, spec):
    """Celda bajo un encabezado de tabla.

    El ancho de la celda lo fija el encabezado de AL LADO (`limite`), no un ancho
    guardado: asi el mapeo aguanta que cambie la tipografia o el ancho de la
    columna. Se toma el primer renglon con contenido debajo del encabezado."""
    pos = pag.buscar_rotulo(spec.get("rotulo", ""), spec.get("ocurrencia", 0))
    if not pos:
        return None
    x0, x1, top = pos
    derecha = None
    if spec.get("limite"):
        lim = pag.buscar_rotulo(spec["limite"])
        if lim and lim[0] > x0:
            derecha = lim[0]
    # Tambien se acota hacia abajo: una celda va PEGADA a su encabezado. Sin este
    # tope, un encabezado con la celda vacia se traia el primer renglon que
    # hubiera mas abajo ("Total Items : 2" en el ticket de Kohls).
    max_abajo = spec.get("max_abajo", 26)
    # Entra la palabra que TERMINA despues del borde izquierdo del rotulo, no solo
    # la que empieza despues: un valor alineado a la derecha arranca antes que su
    # encabezado. Con `x0 >= rotulo` el "CULTURE" de "CULTURE KINGS" (x 435-539,
    # bajo "Due" en 517) se quedaba fuera y la tienda salia como "KINGS".
    abajo = [w for w in pag.palabras
             if top + TOL_RENGLON < w["top"] <= top + max_abajo
             and w["x1"] > x0 - 2
             and (derecha is None or w["x1"] <= derecha)]
    if not abajo:
        return None
    primer_top = min(w["top"] for w in abajo)
    celda = [w for w in abajo if abs(w["top"] - primer_top) <= TOL_RENGLON]
    # Y hacia la izquierda se sigue el valor mientras las palabras vayan PEGADAS
    # (separacion de un espacio): "THE CULTURE KINGS" entero aunque "THE" quede
    # completo antes del rotulo. Un hueco mayor ya es otra columna.
    vecinas = sorted((w for w in pag.palabras
                      if abs(w["top"] - primer_top) <= TOL_RENGLON and w not in celda),
                     key=lambda w: -w["x1"])
    for w in vecinas:
        izq = min(c["x0"] for c in celda)
        alto = max(w.get("bottom", w["top"]) - w["top"], 1)
        if 0 <= izq - w["x1"] <= alto * HUECO_PALABRA_EM:
            celda.append(w)
    celda.sort(key=lambda w: w["x0"])
    return " ".join(w["text"] for w in celda).strip() or None


def _patron(pag, spec):
    """Escape hatch por expresion regular sobre el texto de la pagina.

    OJO con `cruza_renglones`: apagado por defecto a proposito. Con `re.DOTALL`
    un `.+?` se come los saltos de linea y el patron del renglon de estilo
    terminaba casando con la direccion del destinatario. Solo se prende para
    bloques que de verdad son multi-renglon."""
    banderas = re.I | re.M
    if spec.get("cruza_renglones"):
        banderas |= re.S
    m = re.search(spec.get("patron", ""), pag.texto, banderas)
    if not m:
        return None
    try:
        return (m.group(spec.get("grupo", 1)) or "").strip() or None
    except IndexError:
        return None


def _rejilla(pag, spec, mapa_tallas):
    """Tallas leidas de la rejilla rotulada.

    Es la misma tecnica que `printavo_export._extract_sizes_by_position`: se
    localizan los rotulos de tallas y de cantidades, cada bloque de tallas se
    empareja con el PRIMER bloque de cantidades que queda debajo, y solo cuentan
    las palabras de ESOS renglones. Barrer la pagina entera inventa piezas (bug
    del PO 23258: la 'S' final de la descripcion se llevaba un 1 del renglon de
    proporciones). La rejilla puede repetirse — XXS..XL en un bloque y 2XL..5XL
    en otro — por eso se recorren todos los pares."""
    rot_t = spec.get("rotulo_tallas", "SIZE")
    rot_q = spec.get("rotulo_cantidades", "QTY")
    tops_t, tops_q = [], []
    for w in pag.palabras:
        t = _norm(w["text"]).rstrip(">").strip()
        if t == _norm(rot_t):
            tops_t.append((w["top"], w["x1"]))
        elif t == _norm(rot_q):
            tops_q.append((w["top"], w["x1"]))

    sizes, total, renglones = {}, 0, []
    for top_t, x1_t in sorted(tops_t):
        abajo = [(q, x) for q, x in tops_q if q > top_t]
        if not abajo:
            continue
        top_q, x1_q = min(abajo)
        xmin = max(x1_t, x1_q)
        etiquetas, numeros = [], []
        for w in pag.palabras:
            if w["x0"] < xmin:
                continue
            txt = w["text"].strip().upper()
            cx = (w["x0"] + w["x1"]) / 2
            if abs(w["top"] - top_t) <= TOL_RENGLON and txt in mapa_tallas:
                etiquetas.append((cx, txt))
            elif abs(w["top"] - top_q) <= TOL_RENGLON and txt.isdigit() and len(txt) <= 5:
                numeros.append((cx, int(txt)))
        for cx, token in etiquetas:
            mejor, dist = None, 1e9
            for ncx, val in numeros:
                d = abs(ncx - cx)
                if d < TOL_COLUMNA and d < dist:
                    dist, mejor = d, val
            destino = mapa_tallas.get(token)
            if mejor is not None and destino:
                sizes[destino] = sizes.get(destino, 0) + mejor
                total += mejor
                renglones.append(f"{token} - {mejor}")
    return {"sizes": sizes, "total": total, "renglones": renglones}


def _columna(pag, spec):
    """Valor de una COLUMNA de tabla, recortando su rectangulo.

    Para columnas que `derecha_de` y `debajo_de` no alcanzan porque pdfplumber
    junta el texto de columnas vecinas ("WHOLE MILKWHITE" por juntar descripcion
    y color) o porque la celda ocupa varios renglones y el bueno es el de abajo
    (el renglon del estilo trae la abreviacion "LPK" y el de abajo el nombre
    completo "LIGHT PINK").

    El rectangulo se arma con anclas, no con coordenadas guardadas:
      desde   rotulo cuyo borde DERECHO es el borde izquierdo de la columna
              (usar el encabezado anterior: el propio encabezado suele estar
              corrido a la derecha y truncaria el valor)
      limite  rotulo cuyo borde IZQUIERDO cierra la columna
      fondo   palabra que marca el final del bloque hacia abajo
      fila    "ultima" (por defecto) o "primera" dentro del recorte
    """
    izq = pag.buscar_rotulo(spec.get("desde", "")) if spec.get("desde") else None
    anc = pag.buscar_rotulo(spec.get("rotulo", ""), spec.get("ocurrencia", 0)) if spec.get("rotulo") else None
    if not anc:
        return None
    x0 = izq[1] if izq else anc[0]
    top = anc[2]
    der = pag.buscar_rotulo(spec.get("limite", "")) if spec.get("limite") else None
    x1 = der[0] if der else None
    fondo = pag.buscar_rotulo(spec.get("fondo", "")) if spec.get("fondo") else None
    y_fin = fondo[2] + TOL_RENGLON if fondo else top + spec.get("max_abajo", 60)

    # Se recorta con pdfplumber y se lee el texto del recorte en vez de agrupar
    # las palabras a mano: su agrupacion por renglon tolera que las letras de un
    # color de dos palabras no caigan exactamente a la misma altura ("WHISPER
    # WHITE" se partia en dos filas agrupando por top).
    borde = x1 if x1 is not None else pag.page.width
    try:
        recorte = pag.page.crop((max(0, x0 - 1), top + TOL_RENGLON,
                                 min(borde, pag.page.width), min(y_fin, pag.page.height)))
        renglones = [l.strip() for l in (recorte.extract_text() or "").splitlines() if l.strip()]
    except Exception:                                 # noqa: BLE001
        renglones = []
    if not renglones:
        return None
    return renglones[-1] if spec.get("fila", "ultima") == "ultima" else renglones[0]


def _tallas_en_pares(pag, spec, mapa_tallas):
    """Tallas escritas como pares en un renglon: "XS: 5, S: 35, M: 55 Total: 301".

    Es el otro formato comun y el que usa Culture Kings. No hay rejilla que
    anclar: se busca el PRIMER renglon con dos o mas pares "TALLA: n" (uno solo
    seria cualquier campo con dos puntos, como "Units: 301") y se suman.

    `excluir` saca los totales: sin eso, "Total: 301" se contaria como una talla
    mas y duplicaria la cantidad."""
    fuera = {x.strip().upper() for x in (spec.get("excluir") or ["TOTAL", "UNITS"])}
    # El \b inicial impide partir una palabra larga y quedarse con sus ultimos 4
    # caracteres: sin el, "Units: 301" aporta "nits" como si fuera una talla.
    patron = re.compile(r"\b([A-Za-z0-9]{1,4})\s*:\s*(\d+)")
    for linea in pag.lineas:
        pares = [(t, n) for t, n in patron.findall(linea) if t.upper() not in fuera]
        if len(pares) < 2:
            continue
        sizes, total, renglones = {}, 0, []
        for tok, n in pares:
            destino = mapa_tallas.get(tok.upper())
            if not destino:
                continue
            sizes[destino] = sizes.get(destino, 0) + int(n)
            total += int(n)
            renglones.append(f"{tok.upper()} - {n}")
        if sizes:
            return {"sizes": sizes, "total": total, "renglones": renglones}
    return {"sizes": {}, "total": 0, "renglones": []}


def _leer_tallas(pag, spec, mapa_tallas):
    """Despacha al lector de tallas que pida la plantilla."""
    if (spec or {}).get("tipo") == "pares":
        return _tallas_en_pares(pag, spec, mapa_tallas)
    return _rejilla(pag, spec or {}, mapa_tallas)


PRIMITIVAS = {
    "fijo": _fijo,
    "derecha_de": _derecha_de,
    "despues_de": _despues_de,
    "debajo_de": _debajo_de,
    "patron": _patron,
    "columna": _columna,
}


# ── Ejecucion ────────────────────────────────────────────────────────────────

def _coincide_huella(pag, huella):
    """La huella decide si ESTA pagina es de ESTE cliente.

    `contiene` son textos que deben aparecer todos; `no_contiene` son textos que
    la descartan (sirve para separar dos formatos parecidos del mismo cliente)."""
    texto = _norm(pag.texto)
    for s in huella.get("contiene") or []:
        if _norm(s) not in texto:
            return False
    for s in huella.get("no_contiene") or []:
        if _norm(s) in texto:
            return False
    return True


def huella_definida(plantilla):
    """Una plantilla sin al menos un texto en `contiene` acepta CUALQUIER pagina:
    en produccion intentaria leer el PDF de un cliente que nadie reconoce e
    inventaria datos. No se deja activar asi, y si alguna quedo activa sin huella
    (SPEKTRUM nacio antes de esta regla) el lector se la salta."""
    huella = (plantilla or {}).get("huella") or {}
    return any((s or "").strip() for s in (huella.get("contiene") or []))


def _a_numero(v, entero=False):
    """'1,250' -> 1250 ; '1.4500' -> 1.45 ; None si no hay numero."""
    if v is None:
        return None
    m = re.search(r"-?[\d,]*\.?\d+", str(v))
    if not m:
        return None
    try:
        n = float(m.group(0).replace(",", ""))
    except ValueError:
        return None
    return int(round(n)) if entero else n


def leer_pagina(page, plantilla, mapa_tallas, parcial=False):
    """Aplica una plantilla a UNA pagina. Devuelve el registro o None si la
    pagina no es de este cliente (huella) o no trae lo minimo para ser un estilo.

    `parcial=True` es para la pantalla de mapeo: devuelve el registro AUNQUE le
    falte lo minimo, anotando en `_incompleto` que le falta. Sin esto, mientras
    no estuvieran mapeados el numero de diseño Y las tallas no habia registro, y
    la pantalla decia "la regla no encontro nada" en TODOS los campos — incluido
    el que se acababa de mapear bien. En produccion sigue devolviendo None: una
    pagina a medio leer no puede convertirse en una quote."""
    pag = Pagina(page)
    if not _coincide_huella(pag, plantilla.get("huella") or {}):
        return None

    rec = {}
    for campo, spec in (plantilla.get("campos") or {}).items():
        fn = PRIMITIVAS.get((spec or {}).get("tipo"))
        rec[campo] = fn(pag, spec) if fn else None

    rejilla = _leer_tallas(pag, plantilla.get("tallas"), mapa_tallas)
    rec["sizes"] = rejilla["sizes"]
    rec["pack_lines"] = rejilla["renglones"]
    rec["qty_from_sizes"] = rejilla["total"]

    rec["qty"] = _a_numero(rec.get("qty"), entero=True)
    rec["unit_price"] = _a_numero(rec.get("unit_price")) or 0.0
    rec["sizes_match"] = bool(rec["qty"]) and rec["qty"] == rejilla["total"]

    # Minimo para considerarla un estilo: identificador y tallas. Sin esto una
    # portada o una hoja de instrucciones pasaria como estilo vacio.
    falta = [c for c, v in (("design_num", rec.get("design_num")), ("sizes", rec["sizes"])) if not v]
    if falta:
        if not parcial:
            return None
        rec["_incompleto"] = falta

    rec["flags"] = [f for f, falta in (
        ("retailer_missing", not rec.get("brand")),
        ("store_po_missing", not rec.get("store_po")),
        ("po_missing", not rec.get("po_number")),
    ) if falta]
    rec["plantilla"] = plantilla.get("id")
    # De que pagina salio. La pantalla lo usa para enseñar el estilo de LA pagina
    # que se esta viendo: antes mostraba siempre el primero, asi que al mapear en
    # la pagina 3 el valor se buscaba en la 1 y parecia que la regla fallaba.
    rec["_pagina"] = getattr(page, "page_number", None)
    # La plantilla de SALIDA viaja con el registro: asi `build_quote_input` la usa
    # sin tener que consultar la base (corre en hilo aparte) ni recibir un
    # argumento extra por toda la cadena.
    if (plantilla.get("quote") or {}).get("grupos"):
        rec["_quote_tpl"] = plantilla["quote"]
    return _completar(rec, plantilla)


# Lo que `build_quote_input` da por sentado. Una plantilla mapea los datos que el
# PDF del cliente trae; el armador de la quote ademas lee campos de plantilla
# (notas de produccion, metodo de aprobacion, division...) que ese PDF puede no
# tener. Sin estos valores por omision el registro de una plantilla reventaria
# ahi con KeyError. Lo que el cliente SI traiga en su PDF se mapea y pisa esto.
POR_OMISION = {
    "retailer": None, "brand_prefix": None, "store_po_notes": None,
    "description": "", "color": None, "blank": None, "division": "",
    "front_print": "", "approval_method": "", "blanks_trim": "", "blanks_to_use": "",
    "resize": "", "status": "ORIGINAL", "photo_approval": False,
    "sample_required": False, "tops_needed": "", "pack_raw": None,
    "ship_date": None, "cancel_date": None, "store_po": None,
    "po_discrepancy": False, "packing_instructions": [],
}


def _completar(rec, plantilla):
    for k, v in POR_OMISION.items():
        rec.setdefault(k, v)
        if rec.get(k) is None and v not in (None,):
            rec[k] = v
    # El prefijo de la linea de empaque sigue a la tienda cuando el PDF no trae
    # uno propio, igual que en el parser escrito a mano.
    if not rec.get("brand_prefix") and rec.get("brand"):
        rec["brand_prefix"] = str(rec["brand"]).split()[0]
    if not rec.get("retailer"):
        rec["retailer"] = rec.get("brand")
    return rec


def leer_pdf(pdf, plantilla, mapa_tallas, parcial=False):
    """Un registro por pagina que pase la huella (una pagina = un estilo).

    `parcial` sube hasta aqui desde la pantalla de mapeo; ver leer_pagina."""
    out = []
    for page in pdf.pages:
        rec = leer_pagina(page, plantilla, mapa_tallas, parcial=parcial)
        if rec:
            out.append(rec)
    return out
