import { useI18n } from '../i18n';
import { useApi } from '../hooks';
import { presetRange, istToday, type Preset } from '../utils/format';
import type { MenuData, User } from '../types';

export interface FilterState {
  preset: Preset; from: string; to: string; fromTime: string; toTime: string;
  waiterId: string; tableId: string; menuItemId: string;
}
export const initialFilters = (preset: Preset = 'today'): FilterState =>
  ({ preset, ...presetRange(preset), fromTime: '', toTime: '', waiterId: '', tableId: '', menuItemId: '' });

export const filterQuery = (f: FilterState) => ({
  from: f.from, to: f.to, fromTime: f.fromTime || undefined, toTime: f.toTime || undefined,
  waiterId: f.waiterId || undefined, tableId: f.tableId || undefined, menuItemId: f.menuItemId || undefined,
});

const PRESETS: Preset[] = ['today', 'yesterday', 'last7', 'last15', 'last30', 'custom'];

/** Date presets + custom date/time range; admins also get waiter/table/item filters. */
export function Filters({ value, onChange, admin, times = true, presets = PRESETS }: {
  value: FilterState; onChange: (f: FilterState) => void; admin?: boolean; times?: boolean; presets?: Preset[];
}) {
  const { t } = useI18n();
  const users = useApi<User[]>(admin ? '/users' : null, undefined, { cache: true });
  const menu = useApi<MenuData>(admin ? '/menu' : null, undefined, { cache: true });
  const set = (p: Partial<FilterState>) => onChange({ ...value, ...p });
  const today = istToday();

  return (
    <div className="card p-3 mb-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button key={p} onClick={() => set(p === 'custom' ? { preset: p } : { preset: p, ...presetRange(p) })}
            className={`chip border !min-h-10 ${value.preset === p ? 'bg-primary text-white border-primary' : 'bg-white border-line'}`}>{t(`reports.${p}`)}</button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label><span className="label">{t('common.from')}</span><input type="date" className="input" max={today} value={value.from} onChange={(e) => set({ from: e.target.value, to: value.to < e.target.value ? e.target.value : value.to })} /></label>
          <label><span className="label">{t('common.to')}</span><input type="date" className="input" max={today} min={value.from} value={value.to} onChange={(e) => set({ to: e.target.value })} /></label>
          {times && <>
            <label><span className="label">{t('common.startTime')}</span><input type="time" className="input" value={value.fromTime} onChange={(e) => set({ fromTime: e.target.value })} /></label>
            <label><span className="label">{t('common.endTime')}</span><input type="time" className="input" value={value.toTime} onChange={(e) => set({ toTime: e.target.value })} /></label>
          </>}
        </div>
      )}
      {admin && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <select className="input" aria-label={t('common.waiter')} value={value.waiterId} onChange={(e) => set({ waiterId: e.target.value })}>
            <option value="">{t('common.waiter')}: {t('common.all')}</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
          <select className="input" aria-label={t('common.item')} value={value.menuItemId} onChange={(e) => set({ menuItemId: e.target.value })}>
            <option value="">{t('common.item')}: {t('common.all')}</option>
            {(menu.data?.items ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
