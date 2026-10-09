"""Reporte Ejecutivo de Producción: HTML del correo a partir de
production_kpis.build_executive(). Sólo presenta; no calcula nada.

Correo = HTML con estilos en línea y tablas (lo único que respetan Gmail y
Outlook), una columna de ~640px que se lee bien en el celular. Prints (hits) y
Units (piezas) siempre en columnas separadas y rotuladas.
"""
from datetime import date, timedelta
from html import escape

from services.production_kpis import SHIFT_LABELS

C = {"ink": "#0F172A", "muted": "#64748B", "line": "#E2E8F0", "soft": "#F8FAFC",
     "brand": "#0091D5", "good": "#15803D", "bad": "#B91C1C", "warn": "#B45309"}

T = {
    "en": {
        "title": "Production Report", "as_of": "As of {t} (Tijuana)",
        "legend": "Prints = impressions (front + back = 2 prints). Units = garments: per order, the location with the most prints (same rule as the 2026 billing records).",
        "prints": "Prints", "units": "Units", "goal": "Goal", "vs_goal": "vs goal",
        "yesterday": "Yesterday", "today": "Today (so far)",
        "by_shift": "Yesterday by shift", "shift": "Shift",
        "week": "This week", "week_range": "Mon {a} – Sun {b}",
        "produced": "Produced so far", "pending": "Still to produce this week",
        "capacity": "Capacity left (regular + overtime)", "pull": "Room to pull ahead",
        "next": "Next week", "demand": "Demand", "cap": "Capacity", "gap": "Gap (capacity − demand)",
        "regular": "regular", "overtime": "overtime",
        "no_ot": "No overtime is loaded in MOS for these weeks; capacity counts regular shifts only.",
        "week_units_note": "Weekly units count each garment once even when its locations printed on different days, so they are lower than the sum of the days.",
        "test": "Test Orders", "open": "Open orders", "to_print": "To print",
        "in_process": "Printed, in process", "pending_prints": "Pending",
        "ship": "Due to ship (next 7 days, by cancel date)", "date": "Date",
        "machines": "Yesterday by machine", "machine": "Machine",
        "exc": "Exceptions (MOS vs floor)",
        "exc_status": "Printed ≥{p}% but status not advanced",
        "exc_nomove": "Orders on a machine with no capture in {d}+ days",
        "exc_nocap": "Active machines with no capture in {h} h",
        "exc_over": "Over-printed (>{p}% of required)",
        "open_mos": "Open in MOS", "day_goal": "{pct}% of goal",
        "unavailable": "Not available in this send: {s}. The rest of the report is complete.",
        "unknown": "{n} machine-test captures excluded (order contains TEST, UNDO, PROD_ or MACHINE_).",
        "by_client_y": "Yesterday by client", "by_client_w": "This week by client", "client": "Client",
        "none": "None", "days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        "sec": {"production": "daily production", "planning": "weekly planning", "audit": "exceptions"},
    },
    "es": {
        "title": "Reporte de Producción", "as_of": "Corte a las {t} (Tijuana)",
        "legend": "Prints = impresiones (frente + espalda = 2 prints). Unidades = piezas: por orden, la ubicación con más impresiones (misma regla que los registros de facturación 2026).",
        "prints": "Prints", "units": "Unidades", "goal": "Meta", "vs_goal": "vs meta",
        "yesterday": "Ayer", "today": "Hoy (hasta ahora)",
        "by_shift": "Ayer por turno", "shift": "Turno",
        "week": "Esta semana", "week_range": "Lun {a} – Dom {b}",
        "produced": "Producido a la fecha", "pending": "Falta producir esta semana",
        "capacity": "Capacidad restante (regular + extra)", "pull": "Margen para adelantar",
        "next": "Próxima semana", "demand": "Demanda", "cap": "Capacidad", "gap": "Brecha (capacidad − demanda)",
        "regular": "regular", "overtime": "extra",
        "no_ot": "No hay tiempo extra cargado en MOS para estas semanas; la capacidad sólo cuenta turnos regulares.",
        "week_units_note": "Las unidades de la semana cuentan cada pieza una vez aunque sus ubicaciones se imprimieran en días distintos; por eso son menos que la suma de los días.",
        "test": "Test Orders", "open": "Órdenes abiertas", "to_print": "Por imprimir",
        "in_process": "Impresas, en proceso", "pending_prints": "Pendiente",
        "ship": "Por enviar (próximos 7 días, por cancel date)", "date": "Fecha",
        "machines": "Ayer por máquina", "machine": "Máquina",
        "exc": "Excepciones (MOS vs piso)",
        "exc_status": "Impresas ≥{p}% sin avanzar status",
        "exc_nomove": "Órdenes en máquina sin captura en {d}+ días",
        "exc_nocap": "Máquinas activas sin captura en {h} h",
        "exc_over": "Sobreimpresas (>{p}% de lo requerido)",
        "open_mos": "Abrir en MOS", "day_goal": "{pct}% de la meta",
        "unavailable": "No disponible en este envío: {s}. El resto del reporte está completo.",
        "unknown": "{n} capturas de prueba de máquina excluidas (orden con TEST, UNDO, PROD_ o MACHINE_).",
        "by_client_y": "Ayer por cliente", "by_client_w": "Esta semana por cliente", "client": "Cliente",
        "none": "Ninguna", "days": ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"],
        "sec": {"production": "producción del día", "planning": "planeación semanal", "audit": "excepciones"},
    },
}


def _n(v):
    return "—" if v is None else f"{int(round(v)):,}"


def _d(iso, tr, with_dow=True):
    d = date.fromisoformat(iso)
    s = f"{d.month}/{d.day}"
    return f"{tr['days'][d.weekday()]} {s}" if with_dow else s


def _signed(v):
    if v is None:
        return "—", C["muted"]
    return (f"+{int(v):,}" if v >= 0 else f"−{abs(int(v)):,}"), (C["good"] if v >= 0 else C["bad"])


def _h2(text):
    return (f'<tr><td style="padding:22px 0 8px;font:700 13px Arial,sans-serif;letter-spacing:.06em;'
            f'text-transform:uppercase;color:{C["brand"]}">{escape(text)}</td></tr>')


def _table(head, rows, first_left=True):
    th = "".join(
        f'<th style="padding:8px 6px;font:700 11px Arial,sans-serif;color:{C["muted"]};text-transform:uppercase;'
        f'letter-spacing:.04em;border-bottom:2px solid {C["line"]};text-align:{"left" if i == 0 and first_left else "right"}">'
        f'{escape(h)}</th>' for i, h in enumerate(head))
    body = ""
    for r in rows:
        tds = ""
        for i, cell in enumerate(r):
            txt, color, bold = cell if isinstance(cell, tuple) else (cell, C["ink"], False)
            tds += (f'<td style="padding:8px 6px;font:{"700" if bold else "400"} 14px Arial,sans-serif;color:{color};'
                    f'border-bottom:1px solid {C["line"]};text-align:{"left" if i == 0 and first_left else "right"};'
                    f'{"" if i == 0 else "white-space:nowrap"}">{txt}</td>')
        body += f"<tr>{tds}</tr>"
    return (f'<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="border-collapse:collapse">{"<tr>" + th + "</tr>"}{body}</table></td></tr>')


def _note(text, color):
    return (f'<tr><td style="padding:6px 0;font:400 12px Arial,sans-serif;color:{color}">'
            f'{escape(text)}</td></tr>')


def _client_table(clients, tr):
    return _table([tr["client"], tr["prints"], tr["units"]],
                  [[escape(c["client"]), _n(c["hits"]), _n(c["units"])] for c in clients])


def _card(label, prints, units, foot, tr):
    return (f'<td width="50%" valign="top" style="padding:6px">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="background:{C["soft"]};border:1px solid {C["line"]};border-radius:8px">'
            f'<tr><td style="padding:12px 14px 4px;font:700 12px Arial,sans-serif;color:{C["muted"]};'
            f'text-transform:uppercase;letter-spacing:.05em">{escape(label)}</td></tr>'
            f'<tr><td style="padding:0 14px;font:700 26px Arial,sans-serif;color:{C["ink"]}">{_n(prints)}'
            f' <span style="font:400 13px Arial,sans-serif;color:{C["muted"]}">{tr["prints"].lower()}</span></td></tr>'
            f'<tr><td style="padding:0 14px;font:700 18px Arial,sans-serif;color:{C["ink"]}">{_n(units)}'
            f' <span style="font:400 13px Arial,sans-serif;color:{C["muted"]}">{tr["units"].lower()}</span></td></tr>'
            f'<tr><td style="padding:4px 14px 12px;font:400 12px Arial,sans-serif;color:{C["muted"]}">{foot}</td></tr>'
            f'</table></td>')


def _goal_foot(block, tr):
    if not block or not block.get("goal"):
        return "&nbsp;"
    color = C["good"] if (block.get("pct") or 0) >= 100 else C["warn"]
    return (f'{tr["goal"]}: {_n(block["goal"])} · <b style="color:{color}">'
            f'{tr["day_goal"].format(pct=block["pct"])}</b>')


def subject(k: dict, lang: str = "en", base: str = "") -> str:
    tr = T.get(lang, T["en"])
    y = k.get("yesterday") or {}
    head = base.strip() or tr["title"]
    if y:
        return f'{head} — {_d(y["date"], tr)}: {_n(y["hits"])} {tr["prints"].lower()} / {_n(y["units"])} {tr["units"].lower()}'
    return f'{head} — {_d(k["op_today"], tr)}'


def render(k: dict, lang: str = "en", mos_url: str = "") -> str:
    tr = T.get(lang, T["en"])
    rows = []
    gen = k["generated_at"][11:16]
    rows.append(f'<tr><td style="padding:0 0 4px;font:700 22px Arial,sans-serif;color:{C["ink"]}">'
                f'{escape(tr["title"])} · {_d(k["op_today"], tr)}</td></tr>')
    rows.append(f'<tr><td style="font:400 12px Arial,sans-serif;color:{C["muted"]}">'
                f'{tr["as_of"].format(t=gen)} · {escape(tr["legend"])}</td></tr>')
    if k.get("unavailable"):
        secs = ", ".join(tr["sec"].get(s, s) for s in k["unavailable"])
        rows.append(f'<tr><td style="padding:10px 12px;margin-top:8px;background:#FEF3C7;color:{C["warn"]};'
                    f'font:700 13px Arial,sans-serif;border-radius:6px">{escape(tr["unavailable"].format(s=secs))}</td></tr>')

    # 1. Ayer / hoy
    y, t = k.get("yesterday"), k.get("today")
    if y and t:
        rows.append('<tr><td style="padding-top:12px"><table role="presentation" width="100%" cellpadding="0" '
                    'cellspacing="0"><tr>'
                    + _card(f'{tr["yesterday"]} · {_d(y["date"], tr)}', y["hits"], y["units"], _goal_foot(y, tr), tr)
                    + _card(f'{tr["today"]} · {t.get("as_of", "")}', t["hits"], t["units"], _goal_foot(t, tr), tr)
                    + '</tr></table></td></tr>')
        if y["shifts"]:
            rows.append(_h2(tr["by_shift"]))
            has_goal = any(s["goal"] for s in y["shifts"])   # sin metas cargadas no se muestran columnas vacías
            rows.append(_table([tr["shift"], tr["prints"], tr["units"]] + ([tr["goal"], "%"] if has_goal else []), [
                [SHIFT_LABELS.get(s["shift"], {}).get(lang) or escape(s["shift"]), _n(s["hits"]), _n(s["units"])]
                + ([_n(s["goal"]), "—" if s["pct"] is None else f'{s["pct"]}%'] if has_goal else [])
                for s in y["shifts"]]))

        if y.get("clients"):
            rows.append(_h2(tr["by_client_y"]))
            rows.append(_client_table(y["clients"], tr))

    # 2. Semana
    w = k.get("week")
    if w:
        ws = date.fromisoformat(k["week_start"])
        rows.append(_h2(f'{tr["week"]} · {tr["week_range"].format(a=_d(ws.isoformat(), tr, False), b=_d((ws + timedelta(days=6)).isoformat(), tr, False))}'))
        cap_note = f'{_n(w["capacity_regular"])} {tr["regular"]} + {_n(w["capacity_overtime"])} {tr["overtime"]}'
        rows.append(_table(["", tr["prints"], tr["units"]], [
            [tr["produced"], (_n(w["produced_hits"]), C["ink"], True), (_n(w["produced_units"]), C["ink"], True)],
            [tr["pending"], _n(w["pending_hits"]), _n(w["pending_units"])],
            [f'{tr["capacity"]}<br><span style="font-size:12px;color:{C["muted"]}">{cap_note}</span>',
             _n(w["capacity"]), "—"],
            [tr["pull"], (_n(w["pull_ahead"]), C["good"] if w["pull_ahead"] else C["ink"], True), "—"],
        ]))
        if not k.get("overtime_loaded"):
            rows.append(_note(tr["no_ot"], C["warn"]))
        if k.get("week_clients"):
            rows.append(_client_table(k["week_clients"], tr))
        if k.get("week_days"):
            has_goal = any(d["goal"] for d in k["week_days"])
            rows.append(_table([tr["date"], tr["prints"], tr["units"]] + ([tr["goal"]] if has_goal else []), [
                [_d(d["date"], tr), _n(d["hits"]), _n(d["units"])] + ([_n(d["goal"])] if has_goal else [])
                for d in k["week_days"]]))
            rows.append(_note(tr["week_units_note"], C["muted"]))

    # 3. Próxima semana
    nw = k.get("next_week")
    if nw:
        rows.append(_h2(tr["next"]))
        gap, gcol = _signed(nw["delta"])
        rows.append(_table(["", tr["prints"], tr["units"]], [
            [tr["demand"], _n(nw["demand_hits"]), _n(nw["demand_units"])],
            [f'{tr["cap"]}<br><span style="font-size:12px;color:{C["muted"]}">{_n(nw["capacity_regular"])} '
             f'{tr["regular"]} + {_n(nw["capacity_overtime"])} {tr["overtime"]}</span>', _n(nw["capacity"]), "—"],
            [tr["gap"], (gap, gcol, True), "—"],
        ]))
        if not k.get("overtime_loaded"):
            rows.append(_note(tr["no_ot"], C["warn"]))

    # 4. Test Orders
    to = k.get("test_orders")
    if to:
        rows.append(_h2(tr["test"]))
        rows.append(_table(["", ""], [
            [tr["open"], (_n(to.get("open")), C["ink"], True)],
            [tr["to_print"], _n(to.get("to_print"))],
            [tr["in_process"], _n(to.get("printed_in_process"))],
            [f'{tr["pending_prints"]} ({tr["prints"].lower()} / {tr["units"].lower()})',
             f'{_n(to.get("pending"))} / {_n(to.get("pending_units"))}'],
        ]))

    # 5. Envíos
    sh = k.get("shipments")
    if sh is not None:
        rows.append(_h2(tr["ship"]))
        rows.append(_table([tr["date"], tr["prints"], tr["units"]],
                           [[_d(s["date"], tr), _n(s["impressions"]), _n(s.get("units"))] for s in sh]
                           or [[tr["none"], "—", "—"]]))

    # 6. Ayer por máquina
    if y and y.get("machines"):
        rows.append(_h2(tr["machines"]))
        rows.append(_table([tr["machine"], tr["prints"], tr["units"]],
                           [[escape(m["machine"] or "—"), _n(m["hits"]), _n(m["units"])] for m in y["machines"]]))

    # 7. Excepciones
    ex = k.get("exceptions")
    if ex:
        th = ex.get("thresholds") or {}

        def cnt(v):
            return (_n(v), C["bad"] if v else C["good"], True)
        rows.append(_h2(tr["exc"]))
        rows.append(_table(["", ""], [
            [tr["exc_status"].format(p=th.get("printed_pct", 90))
             + (f' <span style="color:{C["muted"]}">({_n(ex["status_behind_hits"])} {tr["prints"].lower()})</span>'
                if ex.get("status_behind_hits") else ""), cnt(ex["status_behind"])],
            [tr["exc_nomove"].format(d=th.get("no_movement_days", 3)), cnt(ex["no_movement"])],
            [tr["exc_nocap"].format(h=th.get("no_capture_hours", 24)), cnt(ex["machine_no_capture"])],
            [tr["exc_over"].format(p=th.get("overprint_pct", 115)), cnt(ex["overprint"])],
        ]))

    if k.get("excluded_test_captures"):
        rows.append(f'<tr><td style="padding-top:10px;font:400 12px Arial,sans-serif;color:{C["muted"]}">'
                    f'{escape(tr["unknown"].format(n=k["excluded_test_captures"]))}</td></tr>')
    if mos_url:
        rows.append(f'<tr><td style="padding:22px 0 0"><a href="{escape(mos_url)}/planeacion?tab=dashboard" '
                    f'style="display:inline-block;background:{C["brand"]};color:#fff;text-decoration:none;'
                    f'font:700 14px Arial,sans-serif;padding:10px 18px;border-radius:6px">{escape(tr["open_mos"])}</a>'
                    f'</td></tr>')
    rows.append(f'<tr><td style="padding:18px 0 0;font:400 11px Arial,sans-serif;color:{C["muted"]}">'
                f'MOS System · Prosper Manufacturing</td></tr>')

    return (f'<div style="background:#fff;padding:16px 8px">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="max-width:640px;margin:0 auto;border-collapse:collapse">{"".join(rows)}</table></div>')
