import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useI18n } from '../i18n';
import { setFocusMode, useApi, usePending } from '../hooks';
import { api } from '../services/api';
import { Loader } from '../components/Brand';
import { Field, Modal, PageHeader, useUi } from '../components/ui';
import { FixtureIcon, TableIcon, type FixtureType } from '../components/FloorIcons';
import { POLL } from '../utils/polling';
import type { Fixture, PriceCategory, Section, Table, TableStatus } from '../types';

type Layout = { sections: Section[]; tables: Table[]; fixtures: Fixture[] };
const STATUSES: TableStatus[] = ['available', 'in_progress', 'occupied'];
const FIXTURES: FixtureType[] = ['entry', 'exit', 'door', 'kitchen'];
const ZOOMS = [2.5, 3.25, 4, 5, 6.25]; // block size in rem
const ZOOM_KEY = 'srbh.layoutZoom';
type Sel = { kind: 'table' | 'fixture'; id: string };

/** Grid size actually needed: the stored size, grown to fit every placed item. */
function gridSize(sec: Section | undefined, tables: { x: number; y: number }[], fixtures: { x: number; y: number }[]) {
  let cols = sec?.cols ?? 8, rows = sec?.rows ?? 8;
  for (const p of [...tables, ...fixtures]) { cols = Math.max(cols, p.x + 1); rows = Math.max(rows, p.y + 1); }
  return { cols, rows };
}

export function TablesPage() {
  const { user } = useAuth();
  const { t } = useI18n();
  const { toast, confirm, errorText } = useUi();
  const nav = useNavigate();
  const pending = usePending();
  const { data, loading, staleAt, reload, error } = useApi<Layout>('/tables', undefined, { poll: POLL.tables, cache: true });
  const [sectionId, setSectionId] = useState('');
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<Layout | null>(null);
  const [selected, setSelected] = useState<Table | null>(null);   // waiter: tapped busy table
  const [sel, setSel] = useState<Sel | null>(null);               // admin edit: item to move/remove
  const [addAt, setAddAt] = useState<{ x: number; y: number } | null>(null);
  const [tableForm, setTableForm] = useState<Partial<Table> | null>(null);
  const [secForm, setSecForm] = useState<{ id?: string; name: string; priceCategory: PriceCategory } | null>(null);
  // Zoom: null = auto "fit to screen width"; a number = the user's own choice (remembered).
  const [userZoom, setUserZoom] = useState<number | null>(() => {
    try { const z = Number(localStorage.getItem(ZOOM_KEY)); if (ZOOMS.includes(z)) return z; } catch { /* ignore */ }
    return null;
  });
  const planRef = useRef<HTMLDivElement>(null);
  const [planWidth, setPlanWidth] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setPlanWidth(planRef.current?.clientWidth ?? 0);
    measure();
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, [!data, edit]); // eslint-disable-line react-hooks/exhaustive-deps -- re-measure once the plan is rendered
  useEffect(() => { setFocusMode(edit); return () => setFocusMode(false); }, [edit]);

  const view: Layout | null = edit && draft ? draft : data ? { ...data, fixtures: data.fixtures ?? [] } : null;
  const sections = view?.sections ?? [];
  useEffect(() => { if (sections.length && !sections.some((s) => s.id === sectionId)) setSectionId(sections[0]!.id); }, [sections, sectionId]);
  const isAdmin = user?.role === 'admin';
  const sec = sections.find((s) => s.id === sectionId);
  const tables = useMemo(() => (view?.tables ?? []).filter((x) => x.sectionId === sectionId), [view, sectionId]);
  const fixtures = useMemo(() => (view?.fixtures ?? []).filter((x) => x.sectionId === sectionId), [view, sectionId]);
  const { cols, rows } = gridSize(sec, tables, fixtures);
  // Largest zoom whose grid fits the visible width (falls back to the smallest; then the plan pans).
  const remPx = typeof window === 'undefined' ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  // Never auto-shrink below a readable block (3.25rem); wider halls pan sideways instead.
  const fitZoom = [...ZOOMS].reverse().find((z) => z >= 3.25 && cols * (z * remPx + 4) + 16 <= planWidth) ?? 3.25;
  const zoom = userZoom ?? fitZoom;
  const setZoomLevel = (dir: 1 | -1) => {
    const n = ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(zoom) + dir))]!;
    try { localStorage.setItem(ZOOM_KEY, String(n)); } catch { /* ignore */ }
    setUserZoom(n);
  };
  const fitToScreen = () => { try { localStorage.removeItem(ZOOM_KEY); } catch { /* ignore */ } setUserZoom(null); };
  const dirty = edit && !!draft && JSON.stringify(draft) !== JSON.stringify({ ...data, fixtures: data?.fixtures ?? [] });
  const cellMap = useMemo(() => {
    const m = new Map<string, { kind: 'table'; item: Table } | { kind: 'fixture'; item: Fixture }>();
    tables.forEach((x) => m.set(`${x.x}:${x.y}`, { kind: 'table', item: x }));
    fixtures.forEach((x) => m.set(`${x.x}:${x.y}`, { kind: 'fixture', item: x }));
    return m;
  }, [tables, fixtures]);

  if (loading && !data) return <Loader label={t('loader.loading')} />;
  if (error && !data) return <div className="card p-6 text-center"><p className="mb-3">{errorText(error)}</p><button className="btn-primary" onClick={() => reload()}>{t('common.retry')}</button></div>;
  const pendingOn = (id: string) => pending.filter((p) => p.tableId === id).length;

  // ---------- waiter ----------
  const open = (tb: Table) => {
    const mineInProgress = tb.status === 'in_progress' && tb.lockedBy === user?.id;
    if (tb.status === 'available' || tb.status === 'billed' || mineInProgress) return nav(`/order/${tb.id}`);
    setSelected(tb);
  };
  const free = async (tb: Table) => {
    if (!(await confirm({ title: t('tables.free'), message: t('tables.freeConfirm', { table: tb.label }) }))) return;
    try { await api(`/tables/${tb.id}/free`, { method: 'POST' }); setSelected(null); void reload(true); } catch (e) { toast(errorText(e), 'error'); }
  };

  // ---------- admin editing (draft, saved with one PUT) ----------
  const startEdit = () => { setDraft(structuredClone({ ...data!, fixtures: data!.fixtures ?? [] })); setEdit(true); setSel(null); };
  const updateDraft = (fn: (d: Layout) => Layout) => setDraft((d) => (d ? fn(structuredClone(d)) : d));
  const putLayout = (d: Layout) => api('/layout', { method: 'PUT', body: {
    sections: d.sections.map((s) => ({ ...s, ...gridSize(s, d.tables.filter((x) => x.sectionId === s.id), d.fixtures.filter((x) => x.sectionId === s.id)) })),
    tables: d.tables.map(({ id, sectionId: sid, x, y }) => ({ id, sectionId: sid, x, y })),
    fixtures: d.fixtures,
  } });
  const saveLayout = async () => {
    try { await putLayout(draft!); toast(t('tables.layoutSaved'), 'success'); setEdit(false); setDraft(null); setSel(null); void reload(true); }
    catch (e) { toast(errorText(e), 'error'); }
  };
  const finishEdit = async () => {
    if (dirty && !(await confirm({ title: t('tables.unsaved'), confirmText: t('tables.done'), danger: true }))) return;
    setEdit(false); setDraft(null); setSel(null);
  };
  const resize = (dc: number, dr: number) => {
    const nc = Math.max(3, cols + dc), nr = Math.max(3, rows + dr);
    if ([...tables, ...fixtures].some((p) => p.x >= nc || p.y >= nr)) { toast(t('layout.notEmpty'), 'error'); return; }
    updateDraft((d) => { const s = d.sections.find((x) => x.id === sectionId)!; s.cols = Math.min(200, nc); s.rows = Math.min(200, nr); return d; });
  };
  const tapCell = (x: number, y: number) => {
    const hit = cellMap.get(`${x}:${y}`);
    if (hit) { setSel(sel?.id === hit.item.id ? null : { kind: hit.kind, id: hit.item.id }); return; }
    if (sel) { // move the selected item here; the grid grows when the last row/column is used
      updateDraft((d) => {
        const it = (sel.kind === 'table' ? d.tables : d.fixtures).find((i) => i.id === sel.id);
        if (it) { it.x = x; it.y = y; it.sectionId = sectionId; }
        const s = d.sections.find((q) => q.id === sectionId)!;
        s.cols = Math.max(cols, x + 2); s.rows = Math.max(rows, y + 2);
        return d;
      });
      setSel(null);
      return;
    }
    setAddAt({ x, y });
  };
  const addFixture = (type: FixtureType) => {
    const at = addAt!;
    updateDraft((d) => ({ ...d, fixtures: [...d.fixtures, { id: `f${Date.now().toString(36)}`, sectionId, type, x: at.x, y: at.y }] }));
    setAddAt(null);
  };
  const removeSelected = async () => {
    if (!sel || !draft) return;
    if (sel.kind === 'fixture') { updateDraft((d) => ({ ...d, fixtures: d.fixtures.filter((f) => f.id !== sel.id) })); setSel(null); return; }
    const tb = draft.tables.find((x) => x.id === sel.id)!;
    if (!(await confirm({ title: t('tables.deleteConfirm', { table: tb.label }), danger: true, confirmText: t('common.delete') }))) return;
    try {
      await api(`/tables/${tb.id}`, { method: 'DELETE' });
      updateDraft((d) => ({ ...d, tables: d.tables.filter((x) => x.id !== tb.id) }));
      setSel(null); void reload(true);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const saveTable = async () => {
    const f = tableForm!;
    try {
      // A brand-new section must exist on the server before a table can reference it.
      if (draft && !data?.sections.some((s) => s.id === (f.sectionId ?? sectionId))) await putLayout(draft);
      const saved = f.id
        ? await api<Table>(`/tables/${f.id}`, { method: 'PATCH', body: { label: f.label, seats: Number(f.seats) } })
        : await api<Table>('/tables', { method: 'POST', body: { label: f.label, seats: Number(f.seats ?? 4), sectionId: f.sectionId ?? sectionId, x: f.x ?? 0, y: f.y ?? 0 } });
      updateDraft((d) => ({ ...d, tables: f.id ? d.tables.map((x) => (x.id === saved.id ? { ...x, label: saved.label, seats: saved.seats } : x)) : [...d.tables, saved] }));
      setTableForm(null); setAddAt(null); setSel(null);
      void reload(true);
    } catch (e) { toast(errorText(e), 'error'); }
  };
  const saveSection = () => {
    if (!draft || !secForm?.name.trim()) return;
    const s: Section = { id: secForm.id ?? `s${Date.now().toString(36)}`, name: secForm.name.trim().slice(0, 30), priceCategory: secForm.priceCategory, cols: 8, rows: 8 };
    updateDraft((d) => ({ ...d, sections: secForm.id ? d.sections.map((x) => (x.id === s.id ? { ...x, name: s.name, priceCategory: s.priceCategory } : x)) : [...d.sections, s] }));
    setSectionId(s.id);
    setSecForm(null);
  };
  const deleteSection = async () => {
    const s = draft?.sections.find((x) => x.id === sectionId);
    if (!s || !draft) return;
    if (draft.tables.some((x) => x.sectionId === s.id) || draft.sections.length === 1) return toast(t('tables.deleteSectionConfirm', { name: s.name }), 'error');
    if (await confirm({ title: t('tables.deleteSectionConfirm', { name: s.name }), danger: true, confirmText: t('common.delete') })) {
      updateDraft((d) => ({ ...d, sections: d.sections.filter((x) => x.id !== s.id), fixtures: d.fixtures.filter((f) => f.sectionId !== s.id) }));
    }
  };
  const selName = sel && (sel.kind === 'table'
    ? draft?.tables.find((x) => x.id === sel.id)?.label
    : t(`fixture.${draft?.fixtures.find((x) => x.id === sel.id)?.type ?? 'door'}`));

  // ---------- render cells ----------
  const cellRem = `${zoom}rem`;
  const cells: ReactNode[] = [];
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const hit = cellMap.get(`${x}:${y}`);
    const style = { gridColumn: x + 1, gridRow: y + 1 };
    if (hit?.kind === 'table') {
      const tb = hit.item;
      const st = tb.status === 'billed' ? 'available' : tb.status;
      cells.push(
        <button key={`t${tb.id}`} style={style} data-testid={`table-${tb.label}`} onClick={() => (edit ? tapCell(x, y) : open(tb))}
          aria-label={`${t('common.table')} ${tb.label} · ${t(`tables.${st}`)}${tb.lockedByName && st === 'in_progress' ? ` · ${tb.lockedByName}` : ''}`}
          className={`relative rounded-xl p-0.5 pb-2.5 transition active:scale-95 ${sel?.id === tb.id ? 'ring-4 ring-primary bg-primary-soft' : 'hover:bg-white/80'}`}>
          <TableIcon status={st} label={tb.label} seats={tb.seats} />
          {zoom >= 4 && <span className="absolute inset-x-0 bottom-0 text-center text-[max(0.58rem,10px)] leading-none font-semibold text-muted truncate px-0.5">
            {st === 'in_progress' && tb.lockedByName ? tb.lockedByName : t(`tables.${st}`)}</span>}
          {pendingOn(tb.id) > 0 && <span className="absolute -top-1 -right-1 rounded-full bg-warning text-white text-[max(0.65rem,10px)] font-bold px-1.5" title={t('net.pendingBadge')}>⏳{pendingOn(tb.id)}</span>}
        </button>,
      );
    } else if (hit?.kind === 'fixture') {
      const f = hit.item;
      cells.push(
        <button key={`f${f.id}`} style={style} disabled={!edit} onClick={() => tapCell(x, y)} aria-label={t(`fixture.${f.type}`)} data-testid={`fixture-${f.type}`}
          className={`relative flex flex-col items-center justify-center gap-0.5 rounded-xl p-1 disabled:opacity-100 disabled:cursor-default ${sel?.id === f.id ? 'ring-4 ring-primary' : ''}`}>
          <span className={`block aspect-square ${zoom >= 4 ? 'h-[68%]' : 'h-[88%]'}`}><FixtureIcon type={f.type} /></span>
          {zoom >= 4 && <span className="text-[max(0.58rem,10px)] leading-tight font-semibold text-muted text-center line-clamp-1 w-full">{t(`fixture.${f.type}`)}</span>}
        </button>,
      );
    } else if (edit) {
      cells.push(
        <button key={`e${x}-${y}`} style={style} onClick={() => tapCell(x, y)} data-testid="empty-cell" aria-label={`${t('layout.addHere')} (${x + 1}, ${y + 1})`}
          className={`rounded-lg border-2 border-dashed text-lg font-bold transition ${sel ? 'border-primary/60 bg-primary-soft/40 text-primary/60' : 'border-line text-line hover:border-primary/40 hover:bg-white'}`}>+</button>,
      );
    }
  }

  return (
    <div className={edit ? 'pb-20 md:pb-0' : ''}>
      <PageHeader title={t('tables.title')} actions={isAdmin && !edit &&
        <button className="btn-ghost" onClick={startEdit} disabled={!navigator.onLine} data-testid="edit-layout">✏️ {t('tables.editLayout')}</button>} />

      {staleAt && <div className="mb-3 rounded-xl bg-warning/15 px-3 py-2 text-sm font-semibold">{t('net.stale', { time: new Date(staleAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) })}</div>}

      {/* Section tabs */}
      <div className="flex gap-2 overflow-x-auto pb-2 mb-2 -mx-1 px-1 [scrollbar-width:none]" role="tablist">
        {sections.map((s) => (
          <button key={s.id} role="tab" aria-selected={s.id === sectionId} onClick={() => { setSectionId(s.id); setSel(null); }}
            className={`chip shrink-0 whitespace-nowrap min-h-11 border ${s.id === sectionId ? 'bg-ink text-white border-ink' : 'bg-white border-line'}`}>
            {s.priceCategory === 'ac' ? '❄️' : '🌀'} {s.name}</button>
        ))}
        {edit && <button className="chip shrink-0 min-h-11 border border-dashed border-primary text-primary whitespace-nowrap" onClick={() => setSecForm({ name: '', priceCategory: 'nonac' })}>＋ {t('tables.addSection')}</button>}
      </div>

      {edit && (
        <div className="card p-2.5 mb-2 border-accent bg-accent-soft/40 space-y-2" data-testid="layout-toolbar">
          <p className="text-xs sm:text-sm text-muted">✋ {sel ? t('layout.moveHint', { name: selName ?? '' }) : t('layout.tapEmpty')}</p>
          {sel ? (
            <div className="flex flex-wrap gap-2 [&>button]:!min-h-10 [&>button]:!py-1 [&>button]:text-sm">
              {sel.kind === 'table' && <button className="btn-ghost bg-white" onClick={() => setTableForm(draft!.tables.find((x) => x.id === sel.id)!)}>✏️ {t('common.edit')}</button>}
              <button className="btn-ghost bg-white text-error" onClick={removeSelected}>🗑️ {t('layout.remove')}</button>
              <button className="btn-ghost bg-white" onClick={() => setSel(null)}>{t('common.cancel')}</button>
            </div>
          ) : (
            <div className="flex gap-2 overflow-x-auto md:flex-wrap -mx-1 px-1 pb-1 [scrollbar-width:none] [&>button]:shrink-0 [&>button]:whitespace-nowrap [&>button]:!min-h-10 [&>button]:!py-1 [&>button]:text-sm">
              <button className="btn-ghost bg-white" onClick={() => resize(0, 1)} data-testid="add-row">＋ {t('layout.addRow')}</button>
              <button className="btn-ghost bg-white" onClick={() => resize(1, 0)} data-testid="add-col">＋ {t('layout.addCol')}</button>
              <button className="btn-ghost bg-white" onClick={() => resize(0, -1)}>－ {t('layout.removeRow')}</button>
              <button className="btn-ghost bg-white" onClick={() => resize(-1, 0)}>－ {t('layout.removeCol')}</button>
              <button className="btn-ghost bg-white" onClick={() => sec && setSecForm({ id: sec.id, name: sec.name, priceCategory: sec.priceCategory ?? 'nonac' })}>✏️ {t('tables.editSection')}</button>
              <button className="btn-ghost bg-white text-error" onClick={deleteSection}>🗑️ {t('tables.section')}</button>
            </div>
          )}
        </div>
      )}

      {/* Zoom + grid size */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs text-muted">{t('layout.size', { cols, rows })}</span>
        <div className="flex gap-1">
          <button className={`btn-ghost !min-h-10 !px-3 text-xs ${userZoom === null ? 'bg-primary-soft border-primary text-primary' : 'bg-white'}`} onClick={fitToScreen} aria-pressed={userZoom === null}>⤢ {t('layout.fit')}</button>
          <button className="btn-ghost !min-h-10 !min-w-10 !px-0 bg-white" onClick={() => setZoomLevel(-1)} aria-label={t('layout.zoomOut')} disabled={zoom === ZOOMS[0]}>－</button>
          <button className="btn-ghost !min-h-10 !min-w-10 !px-0 bg-white" onClick={() => setZoomLevel(1)} aria-label={t('layout.zoomIn')} disabled={zoom === ZOOMS.at(-1)}>＋</button>
        </div>
      </div>

      {/* Floor plan: block grid that pans in both directions when larger than the screen */}
      <div ref={planRef} className={`card overflow-auto overscroll-contain ${edit ? 'ring-2 ring-accent max-h-[calc(100dvh-17rem)]' : 'max-h-[68dvh]'}`} data-testid="floor-plan">
        <div className="grid gap-1 p-2 w-max min-w-full"
          style={{
            gridTemplateColumns: `repeat(${cols}, ${cellRem})`, gridTemplateRows: `repeat(${rows}, ${cellRem})`,
            backgroundImage: edit ? undefined : 'radial-gradient(#E3D6BF 1.3px, transparent 1.3px)',
            backgroundSize: `calc(${cellRem} + 0.25rem) calc(${cellRem} + 0.25rem)`, backgroundPosition: '0.4rem 0.4rem',
          }}>
          {cells}
        </div>
        {!tables.length && !edit && <div className="p-6 text-center text-muted">{t('tables.none')}</div>}
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs sm:text-sm">
        {STATUSES.map((s) => <span key={s} className="flex items-center gap-1.5"><span className="h-6 w-6"><TableIcon status={s} label="" seats={4} /></span>{t(`tables.${s}`)}</span>)}
        {FIXTURES.map((f) => <span key={f} className="flex items-center gap-1.5"><span className="h-5 w-5"><FixtureIcon type={f} /></span>{t(`fixture.${f}`)}</span>)}
      </div>

      {/* Edit mode: Done / Save always reachable — floating above the bottom bar on phones */}
      {edit && (
        <div className="fixed inset-x-0 bottom-0 z-30 bg-card/95 backdrop-blur border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:static md:mt-4 md:border-0 md:bg-transparent md:p-0">
          <div className="flex gap-2 max-w-md mx-auto md:mx-0">
            <button className="btn-ghost flex-1 md:flex-none" onClick={finishEdit}>{t('tables.done')}</button>
            <button className="btn-primary flex-[2] md:flex-none" disabled={!dirty} onClick={saveLayout} data-testid="save-layout">💾 {t('tables.saveLayout')}</button>
          </div>
        </div>
      )}

      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected ? `${t('common.table')} ${selected.label} · ${t(`tables.${selected.status}`)}` : ''}>
        {selected && <div className="grid gap-2">
          {selected.status === 'in_progress' && <p className="text-muted">{t('tables.takenBy', { name: selected.lockedByName ?? '' })}</p>}
          {selected.activeOrderId && <button className="btn-primary" onClick={() => nav(`/orders/${selected.activeOrderId}`)}>🧾 {t('tables.viewBill')}</button>}
          {(selected.status === 'occupied' || (selected.status === 'in_progress' && isAdmin)) &&
            <button className="btn-ghost" onClick={() => free(selected)}>✅ {t('tables.free')}</button>}
        </div>}
      </Modal>

      <Modal open={!!addAt} onClose={() => setAddAt(null)} title={t('layout.addHere')}>
        <div className="grid grid-cols-2 gap-2">
          <button className="btn-secondary col-span-2 !min-h-14" onClick={() => setTableForm({ sectionId, seats: 4, label: '', x: addAt!.x, y: addAt!.y })} data-testid="add-table-here">
            <span className="h-8 w-8"><TableIcon status="available" label="" seats={4} /></span> {t('layout.table')}
          </button>
          {FIXTURES.map((f) => (
            <button key={f} className="btn-ghost bg-white !min-h-14 !justify-start" onClick={() => addFixture(f)} data-testid={`add-${f}`}>
              <span className="h-8 w-8 shrink-0"><FixtureIcon type={f} /></span> {t(`fixture.${f}`)}
            </button>
          ))}
        </div>
      </Modal>

      <Modal open={!!secForm} onClose={() => setSecForm(null)} title={secForm?.id ? t('tables.editSection') : t('tables.addSection')}
        footer={<><button className="btn-ghost" onClick={() => setSecForm(null)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={!secForm?.name.trim()} onClick={saveSection}>{t('common.save')}</button></>}>
        {secForm && <>
          <Field label={t('tables.sectionName')}><input className="input" maxLength={30} value={secForm.name} onChange={(e) => setSecForm({ ...secForm, name: e.target.value })} /></Field>
          <span className="label">{t('hall.label')}</span>
          <div className="grid grid-cols-2 gap-2">
            {(['nonac', 'ac'] as const).map((c) => (
              <button key={c} type="button" onClick={() => setSecForm({ ...secForm, priceCategory: c })} aria-pressed={secForm.priceCategory === c}
                className={`btn border ${secForm.priceCategory === c ? 'bg-primary text-white border-primary' : 'bg-white border-line'}`}>{c === 'ac' ? '❄️' : '🌀'} {t(`hall.${c}`)}</button>
            ))}
          </div>
        </>}
      </Modal>

      <Modal open={!!tableForm} onClose={() => setTableForm(null)} title={tableForm?.id ? t('tables.editTable') : t('tables.addTable')}
        footer={<><button className="btn-ghost" onClick={() => setTableForm(null)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={!tableForm?.label?.trim()} onClick={saveTable} data-testid="table-save">{t('common.save')}</button></>}>
        {tableForm && <>
          <Field label={t('tables.number')}><input className="input" maxLength={12} value={tableForm.label ?? ''} onChange={(e) => setTableForm({ ...tableForm, label: e.target.value })} placeholder="T9" data-testid="table-label" /></Field>
          <Field label={t('tables.seats', { n: '' }).trim()}><input className="input" type="number" min={1} max={30} inputMode="numeric" value={tableForm.seats ?? 4} onChange={(e) => setTableForm({ ...tableForm, seats: Number(e.target.value) })} /></Field>
        </>}
      </Modal>
    </div>
  );
}
