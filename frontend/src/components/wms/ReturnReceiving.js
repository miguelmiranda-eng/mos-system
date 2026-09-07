/* Recepción de material de retorno — lo que sobra de producción y vuelve al
   almacén.

   REGLA DEL MÓDULO: los seis campos de identidad (cliente, estilo, color, talla,
   país de origen y composición) salen del catálogo curado de Configuración WMS.
   Ninguno se teclea libre — todos los selects van con allowCreate={false}. País
   y composición son obligatorios: por teclearlos a mano en el flujo viejo, el
   78% del material retornado entró sin país de origen, que aquí es parte de la
   identidad del lote y requisito de etiquetado.

   FLUJO: capturar → se mintean N cajas (etiqueta nueva cada una) marcadas como
   retorno y se acopian → las cajas se acumulan en la lista → se seleccionan con
   casilla y se mandan a su ubicación definitiva, confirmando cuántas y a dónde.

   CANTIDAD ES POR CAJA: cuando vuelve una tarima con varias cajas iguales se
   captura "Cajas" y el módulo mintea ese número de LPNs, cada uno con su propia
   etiqueta. Capturar el total en una sola caja mentiría en la etiqueta y
   obligaría a partirla después en Mover. */
import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Undo2, Plus, Loader2, MapPin, Printer, X, PackageCheck } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { useLang } from "../../contexts/LanguageContext";
import { fetcher, poster, logLoadError, useWmsSizes, useWmsCatalogs, mergeUnique, API } from "./lib";
import { Card, Btn, Chip, EmptyState, SoftAlert, cls } from "./ui";

const EMPTY = {
  customer: "", style: "", color: "", size: "",
  units: "", box_count: "1", country_of_origin: "", fabric_content: "",
};

// Tope por captura, espejo del backend (MAX_BOXES_POR_CAPTURA). Freno a la mano
// pesada en el teclado: cada caja es un folio que ya no se puede deshacer.
const MAX_CAJAS = 100;

export default function ReturnReceiving() {
  const { t } = useLang();
  const cat = useWmsCatalogs();
  const { all: ALL_SIZES } = useWmsSizes();

  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [pending, setPending] = useState([]);
  const [staging, setStaging] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);

  const [locNames, setLocNames] = useState([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [dest, setDest] = useState("");
  const [moving, setMoving] = useState(false);

  // Estilos y colores son por cliente (el resto del catálogo es global). Sin
  // cliente elegido no se ofrecen los de OTRO cliente.
  const [custStyles, setCustStyles] = useState([]);
  const [custColors, setCustColors] = useState([]);

  const loadPending = useCallback(() => {
    setLoading(true);
    fetcher("/returns/pending")
      .then(d => { setPending(d?.items || []); setStaging(d?.staging || ""); })
      .catch(logLoadError("returns"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadPending(); }, [loadPending]);
  useEffect(() => {
    // Devuelve [{name, zone}] — al dropdown sólo le sirven los nombres.
    fetcher("/locations/names")
      .then(rows => setLocNames((rows || []).map(r => r.name).filter(Boolean)))
      .catch(logLoadError("locations"));
  }, []);

  useEffect(() => {
    const c = (form.customer || "").trim();
    if (!c) { setCustStyles([]); setCustColors([]); return; }
    fetcher(`/catalogs/styles?customer=${encodeURIComponent(c)}`)
      .then(d => setCustStyles(d?.styles || [])).catch(() => setCustStyles([]));
    fetcher(`/catalogs/colors/for-customer?customer=${encodeURIComponent(c)}`)
      .then(d => setCustColors(d?.values || [])).catch(() => setCustColors([]));
  }, [form.customer]);

  const styleOptions = useMemo(() => mergeUnique(custStyles), [custStyles]);
  const colorOptions = useMemo(() => mergeUnique(custColors, cat.colors), [custColors, cat.colors]);
  const sizeOptions = useMemo(() => mergeUnique(cat.sizes, ALL_SIZES), [cat.sizes, ALL_SIZES]);

  const set = (k) => (v) => setForm(p => ({ ...p, [k]: v }));
  const units = parseInt(form.units, 10) || 0;
  const cajas = parseInt(form.box_count, 10) || 0;
  const cajasOk = cajas >= 1 && cajas <= MAX_CAJAS;
  const completo = form.customer && form.style && form.color && form.size &&
                   units > 0 && cajasOk && form.country_of_origin && form.fabric_content;

  const abrirEtiquetas = (ids) => {
    const limpios = (ids || []).filter(Boolean);
    if (!limpios.length) return;
    const url = limpios.length === 1
      ? `${API}/labels/box/${encodeURIComponent(limpios[0])}`
      : `${API}/labels/boxes?box_ids=${limpios.map(encodeURIComponent).join(",")}`;
    const w = window.open(url, "_blank");
    if (!w) toast.error(t('wms_popup_err'));
  };

  const guardar = async () => {
    if (!completo) { toast.error(t('wms_ret_fill_all')); return; }
    setSaving(true);
    try {
      const res = await poster("/returns/receive", { ...form, units, box_count: cajas });
      if (res.ok) {
        const data = await res.json();
        // El backend responde la primera caja en la raíz por compatibilidad;
        // `box_ids` trae las N para imprimir de un solo tirón.
        const ids = data.box_ids?.length ? data.box_ids : [data.box_id];
        toast.success(ids.length === 1
          ? t('wms_ret_box_generated', { box: ids[0], units })
          : t('wms_ret_boxes_generated', { n: ids.length, units, total: (units * ids.length).toLocaleString() }));
        abrirEtiquetas(ids);
        // El cliente se conserva: casi siempre se capturan varios renglones del
        // mismo cliente seguidos.
        setForm(p => ({ ...EMPTY, customer: p.customer }));
        loadPending();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || t('wms_ret_register_err'));
      }
    } catch { toast.error(t('wms_conn_error')); }
    finally { setSaving(false); }
  };

  const toggle = (id) =>
    setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);
  const allIds = pending.map(b => b.box_id);
  const allSel = allIds.length > 0 && allIds.every(id => selected.includes(id));
  const toggleAll = () => setSelected(allSel ? [] : allIds);

  const seleccionadas = pending.filter(b => selected.includes(b.box_id));
  const unidadesSel = seleccionadas.reduce((s, b) => s + (parseInt(b.units, 10) || 0), 0);

  const mover = async () => {
    if (!dest || seleccionadas.length === 0) return;
    setMoving(true);
    try {
      const res = await poster("/putaway/bulk", {
        assignments: seleccionadas.map(b => ({ box_id: b.box_id, location: dest })),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(data.message || t('wms_ret_boxes_located', { n: seleccionadas.length }));
        if (data.failed?.length) {
          toast.error(t('wms_ret_n_with_error', { n: data.failed.length, reason: data.failed[0]?.reason || "" }));
        }
        setSelected([]); setMoveOpen(false); setDest("");
        loadPending();
      } else {
        toast.error(data.detail || t('wms_ret_move_err'));
      }
    } catch { toast.error(t('wms_conn_error')); }
    finally { setMoving(false); }
  };

  // Etiqueta OFICIAL del WMS (misma que Mover / Locations / BoxSearch): trae el
  // código de barras del LPN, la ubicación en grande y los datos de recibo. La
  // que vivía aquí se armaba a mano y salía sin barras, sin ubicación y sin
  // quién recibió — una caja que no se podía escanear ni ubicar.
  const imprimir = (box) => abrirEtiquetas([box.box_id]);

  return (
    <div className="space-y-5" data-testid="return-receiving">
      <SoftAlert tone="info" title={t('wms_ret_alert_title')}>
        {t('wms_ret_alert_body_1')}
        {staging ? <> {t('wms_ret_alert_in')} <span className="font-mono font-medium">{staging}</span></> : null}
        {" "}{t('wms_ret_alert_body_2')}
      </SoftAlert>

      {/* ── Captura ─────────────────────────────────────────────────────── */}
      {!showForm ? (
        <Btn variant="primary" onClick={() => setShowForm(true)} data-testid="ret-open-form">
          <Undo2 className="w-4 h-4" /> {t('wms_ret_receive_btn')}
        </Btn>
      ) : (
        <Card className="p-5 space-y-4" data-testid="ret-form">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Undo2 className="w-4 h-4 text-muted-foreground" /> {t('wms_ret_receive_btn')}
            </h3>
            <Btn variant="ghost" onClick={() => { setShowForm(false); setForm(EMPTY); }}>
              <X className="w-4 h-4" />
            </Btn>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label={t('wms_label_customer')}>
              <SearchableSelect options={cat.customers} value={form.customer}
                onChange={v => setForm(p => ({ ...p, customer: v, style: "", color: "" }))}
                placeholder={t('wms_ret_ph_customer')} testId="ret-customer" allowCreate={false} />
            </Field>
            <Field label={t('wms_label_style')}>
              <SearchableSelect options={styleOptions} value={form.style} onChange={set("style")}
                placeholder={form.customer && styleOptions.length === 0
                  ? t('wms_customer_no_catalog') : t('wms_ret_ph_style')}
                testId="ret-style" allowCreate={false}
                disabled={!form.customer || styleOptions.length === 0} />
            </Field>
            <Field label={t('wms_label_color')}>
              <SearchableSelect options={colorOptions} value={form.color} onChange={set("color")}
                placeholder={t('wms_ret_ph_color')} testId="ret-color" allowCreate={false}
                disabled={!form.customer} />
            </Field>
            <Field label={t('wms_label_size')}>
              <SearchableSelect options={sizeOptions} value={form.size} onChange={set("size")}
                placeholder={t('wms_ret_ph_size')} testId="ret-size" allowCreate={false} />
            </Field>
            <Field label={t('wms_ret_units_per_box')}>
              <input type="number" min="1" inputMode="numeric" className={cls.input}
                value={form.units} onChange={e => set("units")(e.target.value)}
                placeholder={t('wms_ret_ph_pieces')} data-testid="ret-units" />
            </Field>
            {/* Varias cajas idénticas en un solo movimiento: se mintea un LPN
                por caja, cada uno con su etiqueta. */}
            <Field label={t('wms_boxes')}>
              <input type="number" min="1" max={MAX_CAJAS} inputMode="numeric" className={cls.input}
                value={form.box_count} onChange={e => set("box_count")(e.target.value)}
                placeholder="1" data-testid="ret-box-count" />
            </Field>
            <Field label={t('wms_label_coo')}>
              <SearchableSelect options={cat.countries} value={form.country_of_origin}
                onChange={set("country_of_origin")} placeholder={t('wms_ret_ph_country')}
                testId="ret-country" allowCreate={false} />
            </Field>
            <Field label={t('wms_ret_composition')}>
              <SearchableSelect options={cat.fabrics} value={form.fabric_content}
                onChange={set("fabric_content")} placeholder={t('wms_ret_ph_composition')}
                testId="ret-fabric" allowCreate={false} />
            </Field>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Btn variant="primary" onClick={guardar} disabled={!completo || saving}
              data-testid="ret-submit">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {cajas > 1 ? t('wms_ret_generate_n_boxes', { n: cajas }) : t('wms_ret_generate_box')}
            </Btn>
            {!completo ? (
              <span className="text-xs text-muted-foreground">
                {cajas > MAX_CAJAS
                  ? t('wms_ret_max_boxes', { max: MAX_CAJAS })
                  : t('wms_ret_missing_data')}
              </span>
            ) : cajas > 1 ? (
              <span className="text-xs text-muted-foreground" data-testid="ret-total-preview">
                {t('wms_ret_preview_a', { boxes: cajas, units: units.toLocaleString() })}{" "}
                <strong className="text-foreground tabular-nums">
                  {(cajas * units).toLocaleString()}
                </strong>{" "}{t('wms_ret_preview_b', { n: cajas })}
              </span>
            ) : null}
          </div>
        </Card>
      )}

      {/* ── Acopio ──────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <PackageCheck className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold">{t('wms_ret_staging_title')}</span>
            <Chip>{t('wms_boxes_count', { n: pending.length })}</Chip>
            <Chip tone="info">
              {pending.reduce((s, b) => s + (parseInt(b.units, 10) || 0), 0).toLocaleString()} u
            </Chip>
          </div>
          {selected.length > 0 && (
            <div className="flex items-center gap-2">
              {/* Reimprimir en lote: la selección ya existía para mover, pero si
                  se atoró la impresora o se despegó la etiqueta había que sacar
                  las cajas una por una. */}
              <Btn onClick={() => abrirEtiquetas(selected)} data-testid="ret-print-many">
                <Printer className="w-4 h-4" /> {t('wms_ret_labels_n', { n: selected.length })}
              </Btn>
              <Btn variant="primary" onClick={() => setMoveOpen(true)} data-testid="ret-move-open">
                <MapPin className="w-4 h-4" /> {t('wms_ret_send_to_loc_n', { n: selected.length })}
              </Btn>
            </div>
          )}
        </div>

        {loading ? (
          <div className="p-8 flex justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : pending.length === 0 ? (
          <EmptyState art="rack" title={t('wms_ret_empty_title')}
            hint={t('wms_ret_empty_hint')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className="px-3 py-2.5 w-10">
                    <input type="checkbox" checked={allSel} onChange={toggleAll}
                      aria-label={t('select_all')} data-testid="ret-select-all"
                      className="rounded border-input" />
                  </th>
                  <th className={cls.th}>{t('wms_box')}</th>
                  <th className={cls.th}>{t('wms_label_customer')}</th>
                  <th className={cls.th}>{t('wms_label_style')}</th>
                  <th className={cls.th}>{t('wms_label_color')}</th>
                  <th className={cls.th}>{t('wms_label_size')}</th>
                  <th className={`${cls.th} text-right`}>{t('wms_label_units')}</th>
                  <th className={cls.th}>{t('wms_origin')}</th>
                  <th className={cls.th}></th>
                </tr>
              </thead>
              <tbody>
                {pending.map(b => (
                  <tr key={b.box_id}
                    className={`border-b border-border/50 last:border-0 hover:bg-muted/40 ${
                      selected.includes(b.box_id) ? "bg-primary/5" : ""}`}>
                    <td className={cls.td}>
                      <input type="checkbox" checked={selected.includes(b.box_id)}
                        onChange={() => toggle(b.box_id)} className="rounded border-input"
                        aria-label={t('wms_select_box_aria', { box: b.box_id })}
                        data-testid={`ret-check-${b.box_id}`} />
                    </td>
                    <td className={`${cls.td} font-mono text-xs`}>{b.box_id}</td>
                    <td className={cls.td}>{b.customer}</td>
                    <td className={`${cls.td} font-medium`}>{b.style}</td>
                    <td className={cls.td}>{b.color}</td>
                    <td className={cls.td}>{b.size}</td>
                    <td className={`${cls.td} text-right tabular-nums font-medium`}>
                      {(parseInt(b.units, 10) || 0).toLocaleString()}
                    </td>
                    <td className={`${cls.td} text-xs text-muted-foreground`}>{b.country_of_origin}</td>
                    <td className={`${cls.td} text-right`}>
                      <Btn variant="ghost" onClick={() => imprimir(b)} title={t('wms_print_label')}>
                        <Printer className="w-3.5 h-3.5" />
                      </Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── Modal de ubicación ──────────────────────────────────────────── */}
      {moveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !moving && setMoveOpen(false)}>
          <Card className="w-full max-w-sm p-5 space-y-4" onClick={e => e.stopPropagation()}
            data-testid="ret-move-modal">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <MapPin className="w-4 h-4 text-muted-foreground" /> {t('wms_ret_send_to_loc')}
            </h3>

            <SearchableSelect options={locNames} value={dest} onChange={setDest}
              placeholder={t('wms_search_location_ph')} testId="ret-dest" allowCreate={false} />

            <p className="text-sm text-muted-foreground" data-testid="ret-move-confirm-text">
              {t('wms_ret_move_confirm_a')} <strong className="text-foreground">{seleccionadas.length}</strong>
              {" "}{seleccionadas.length === 1 ? t('wms_box_lower') : t('wms_boxes_lower')}
              {" "}(<span className="tabular-nums">{unidadesSel.toLocaleString()}</span> u) {t('wms_ret_move_confirm_to')}{" "}
              <strong className="text-foreground font-mono">{dest || "…"}</strong>
            </p>

            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setMoveOpen(false)} disabled={moving}>
                {t('cancel')}
              </Btn>
              <Btn variant="primary" onClick={mover} disabled={!dest || moving}
                data-testid="ret-move-confirm">
                {moving ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                {t('confirm')}
              </Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

const Field = ({ label, children }) => (
  <div>
    <label className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
    {children}
  </div>
);
