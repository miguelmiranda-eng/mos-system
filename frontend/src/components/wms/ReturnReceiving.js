/* Recepción de material de retorno — lo que sobra de producción y vuelve al
   almacén.

   REGLA DEL MÓDULO: los seis campos de identidad (cliente, estilo, color, talla,
   país de origen y composición) salen del catálogo curado de Configuración WMS.
   Ninguno se teclea libre — todos los selects van con allowCreate={false}. País
   y composición son obligatorios: por teclearlos a mano en el flujo viejo, el
   78% del material retornado entró sin país de origen, que aquí es parte de la
   identidad del lote y requisito de etiquetado.

   FLUJO: capturar → se mintea una caja (etiqueta nueva) marcada como retorno y
   se acopia → las cajas se acumulan en la lista → se seleccionan con casilla y
   se mandan a su ubicación definitiva, confirmando cuántas y a dónde. */
import { useState, useEffect, useCallback, useMemo } from "react";
import { toast } from "sonner";
import { Undo2, Plus, Loader2, MapPin, Printer, X, PackageCheck } from "lucide-react";
import SearchableSelect from "../SearchableSelect";
import { fetcher, poster, logLoadError, useWmsSizes, useWmsCatalogs, mergeUnique } from "./lib";
import { Card, Btn, Chip, EmptyState, SoftAlert, cls } from "./ui";

const EMPTY = {
  customer: "", style: "", color: "", size: "",
  units: "", country_of_origin: "", fabric_content: "",
};

export default function ReturnReceiving() {
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
  const completo = form.customer && form.style && form.color && form.size &&
                   units > 0 && form.country_of_origin && form.fabric_content;

  const guardar = async () => {
    if (!completo) { toast.error("Completa todos los campos"); return; }
    setSaving(true);
    try {
      const res = await poster("/returns/receive", { ...form, units });
      if (res.ok) {
        const box = await res.json();
        toast.success(`Caja ${box.box_id} generada · ${units} u`);
        // El cliente se conserva: casi siempre se capturan varios renglones del
        // mismo cliente seguidos.
        setForm(p => ({ ...EMPTY, customer: p.customer }));
        loadPending();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || "No se pudo registrar el retorno");
      }
    } catch { toast.error("Error de conexión"); }
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
        toast.success(data.message || `${seleccionadas.length} cajas ubicadas`);
        if (data.failed?.length) {
          toast.error(`${data.failed.length} con error: ${data.failed[0]?.reason || ""}`);
        }
        setSelected([]); setMoveOpen(false); setDest("");
        loadPending();
      } else {
        toast.error(data.detail || "No se pudieron mover las cajas");
      }
    } catch { toast.error("Error de conexión"); }
    finally { setMoving(false); }
  };

  const imprimir = (box) => {
    const w = window.open("", "_blank", "width=420,height=640");
    if (!w) return;
    w.document.write(
      `<html><head><title>${box.box_id}</title><style>@page{size:4in 6in;margin:6mm}` +
      `body{font-family:Arial,sans-serif;padding:12px;width:3.6in}</style></head><body>` +
      `<div style="text-align:center;font-size:13px;font-weight:bold;letter-spacing:2px;` +
      `border:2px solid #000;padding:4px;margin-bottom:10px">MATERIAL DE RETORNO</div>` +
      `<div style="text-align:center;font-size:22px;font-weight:900;font-family:monospace">${box.box_id}</div>` +
      `<div style="text-align:center;font-size:13px;margin:8px 0">${box.customer || ""}</div>` +
      `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px">` +
      `<tr><td style="border:1px solid #000;padding:4px">Estilo</td><td style="border:1px solid #000;padding:4px;font-weight:bold">${box.style || ""}</td></tr>` +
      `<tr><td style="border:1px solid #000;padding:4px">Color</td><td style="border:1px solid #000;padding:4px;font-weight:bold">${box.color || ""}</td></tr>` +
      `<tr><td style="border:1px solid #000;padding:4px">Talla</td><td style="border:1px solid #000;padding:4px;font-weight:bold">${box.size || ""}</td></tr>` +
      `<tr><td style="border:1px solid #000;padding:4px">Unidades</td><td style="border:1px solid #000;padding:4px;font-size:18px;font-weight:900">${box.units ?? ""}</td></tr>` +
      `<tr><td style="border:1px solid #000;padding:4px">Origen</td><td style="border:1px solid #000;padding:4px">${box.country_of_origin || ""}</td></tr>` +
      `<tr><td style="border:1px solid #000;padding:4px">Composición</td><td style="border:1px solid #000;padding:4px;font-size:10px">${box.fabric_content || ""}</td></tr>` +
      `</table><script>setTimeout(function(){window.print()},300);<\/script></body></html>`
    );
    w.document.close();
  };

  return (
    <div className="space-y-5" data-testid="return-receiving">
      <SoftAlert tone="info" title="Material que regresa de producción">
        Se genera una etiqueta nueva marcada como retorno y la caja queda en acopio
        {staging ? <> en <span className="font-mono font-medium">{staging}</span></> : null}
        {" "}hasta que la mandes a su ubicación. Todos los datos salen del catálogo de
        Configuración: el país de origen y la composición son obligatorios porque son
        parte de la identidad del lote.
      </SoftAlert>

      {/* ── Captura ─────────────────────────────────────────────────────── */}
      {!showForm ? (
        <Btn variant="primary" onClick={() => setShowForm(true)} data-testid="ret-open-form">
          <Undo2 className="w-4 h-4" /> Recibir material de retorno
        </Btn>
      ) : (
        <Card className="p-5 space-y-4" data-testid="ret-form">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <Undo2 className="w-4 h-4 text-muted-foreground" /> Recibir material de retorno
            </h3>
            <Btn variant="ghost" onClick={() => { setShowForm(false); setForm(EMPTY); }}>
              <X className="w-4 h-4" />
            </Btn>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Field label="Cliente">
              <SearchableSelect options={cat.customers} value={form.customer}
                onChange={v => setForm(p => ({ ...p, customer: v, style: "", color: "" }))}
                placeholder="Cliente…" testId="ret-customer" allowCreate={false} />
            </Field>
            <Field label="Estilo">
              <SearchableSelect options={styleOptions} value={form.style} onChange={set("style")}
                placeholder={form.customer && styleOptions.length === 0
                  ? "Cliente sin catálogo — pídele al líder" : "Estilo…"}
                testId="ret-style" allowCreate={false}
                disabled={!form.customer || styleOptions.length === 0} />
            </Field>
            <Field label="Color">
              <SearchableSelect options={colorOptions} value={form.color} onChange={set("color")}
                placeholder="Color…" testId="ret-color" allowCreate={false}
                disabled={!form.customer} />
            </Field>
            <Field label="Talla">
              <SearchableSelect options={sizeOptions} value={form.size} onChange={set("size")}
                placeholder="Talla…" testId="ret-size" allowCreate={false} />
            </Field>
            <Field label="Cantidad">
              <input type="number" min="1" inputMode="numeric" className={cls.input}
                value={form.units} onChange={e => set("units")(e.target.value)}
                placeholder="Piezas…" data-testid="ret-units" />
            </Field>
            <Field label="País de origen">
              <SearchableSelect options={cat.countries} value={form.country_of_origin}
                onChange={set("country_of_origin")} placeholder="País…"
                testId="ret-country" allowCreate={false} />
            </Field>
            <Field label="Composición">
              <SearchableSelect options={cat.fabrics} value={form.fabric_content}
                onChange={set("fabric_content")} placeholder="Composición…"
                testId="ret-fabric" allowCreate={false} />
            </Field>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <Btn variant="primary" onClick={guardar} disabled={!completo || saving}
              data-testid="ret-submit">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Generar caja
            </Btn>
            {!completo && (
              <span className="text-xs text-muted-foreground">
                Faltan datos — los siete campos son obligatorios
              </span>
            )}
          </div>
        </Card>
      )}

      {/* ── Acopio ──────────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <PackageCheck className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-semibold">En acopio</span>
            <Chip>{pending.length} cajas</Chip>
            <Chip tone="info">
              {pending.reduce((s, b) => s + (parseInt(b.units, 10) || 0), 0).toLocaleString()} u
            </Chip>
          </div>
          {selected.length > 0 && (
            <Btn variant="primary" onClick={() => setMoveOpen(true)} data-testid="ret-move-open">
              <MapPin className="w-4 h-4" /> Enviar a ubicación ({selected.length})
            </Btn>
          )}
        </div>

        {loading ? (
          <div className="p-8 flex justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : pending.length === 0 ? (
          <EmptyState title="Sin material en acopio"
            hint="Lo que recibas de retorno aparece aquí hasta que lo mandes a su ubicación." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border">
                <tr>
                  <th className="px-3 py-2.5 w-10">
                    <input type="checkbox" checked={allSel} onChange={toggleAll}
                      aria-label="Seleccionar todas" data-testid="ret-select-all"
                      className="rounded border-input" />
                  </th>
                  <th className={cls.th}>Caja</th>
                  <th className={cls.th}>Cliente</th>
                  <th className={cls.th}>Estilo</th>
                  <th className={cls.th}>Color</th>
                  <th className={cls.th}>Talla</th>
                  <th className={`${cls.th} text-right`}>Unidades</th>
                  <th className={cls.th}>Origen</th>
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
                        aria-label={`Seleccionar ${b.box_id}`}
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
                      <Btn variant="ghost" onClick={() => imprimir(b)} title="Imprimir etiqueta">
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
              <MapPin className="w-4 h-4 text-muted-foreground" /> Enviar a ubicación
            </h3>

            <SearchableSelect options={locNames} value={dest} onChange={setDest}
              placeholder="Buscar ubicación…" testId="ret-dest" allowCreate={false} />

            <p className="text-sm text-muted-foreground" data-testid="ret-move-confirm-text">
              Moverás <strong className="text-foreground">{seleccionadas.length}</strong>
              {seleccionadas.length === 1 ? " caja" : " cajas"}
              {" "}(<span className="tabular-nums">{unidadesSel.toLocaleString()}</span> u) a{" "}
              <strong className="text-foreground font-mono">{dest || "…"}</strong>
            </p>

            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setMoveOpen(false)} disabled={moving}>
                Cancelar
              </Btn>
              <Btn variant="primary" onClick={mover} disabled={!dest || moving}
                data-testid="ret-move-confirm">
                {moving ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                Confirmar
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
