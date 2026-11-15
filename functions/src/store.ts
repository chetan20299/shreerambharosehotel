import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { db } from './db.js';
import type { MenuItem } from './orders.js';

/**
 * Compact single-document storage (free-tier friendly — Firestore bills per document read/write, not per byte):
 *   floorLayouts/main → { sections[], fixtures[], tables: { [id]: CompactTable } }   whole floor plan = 1 read
 *   config/menu       → { categories: { [id]: … }, items: { [id]: … } }             whole menu       = 1 read
 * Table state changes are single field-path updates on the floor document (1 write).
 * A document can hold 1 MiB — thousands of tables/items, far beyond one hotel.
 */
export const FLOOR = () => db.doc('floorLayouts/main');
export const MENU = () => db.doc('config/menu');

/** Compact table: status/lock fields exist only while the table is busy (absent = available). */
export interface CompactTable {
  label: string; sectionId: string; x: number; y: number; seats: number;
  st?: 'in_progress' | 'occupied'; order?: string; lockBy?: string; lockName?: string; lockUntil?: number;
}
export interface Section { id: string; name: string; priceCategory?: 'ac' | 'nonac'; cols?: number; rows?: number }
export interface Fixture { id: string; sectionId: string; type: 'entry' | 'exit' | 'door' | 'kitchen'; x: number; y: number }
export interface Floor { sections: Section[]; fixtures: Fixture[]; tables: Record<string, CompactTable> }

export async function readFloor(tx?: Transaction): Promise<Floor> {
  const d = (tx ? await tx.get(FLOOR()) : await FLOOR().get()).data() ?? {};
  return { sections: d.sections ?? [], fixtures: d.fixtures ?? [], tables: d.tables ?? {} };
}

/** API shape of a table; an expired order-entry lock reads as available. */
export function viewTable(id: string, t: CompactTable) {
  const lockLive = t.st === 'in_progress' && (t.lockUntil ?? 0) > Date.now();
  const status = t.st === 'occupied' ? 'occupied' : lockLive ? 'in_progress' : 'available';
  return {
    id, label: t.label, sectionId: t.sectionId, x: t.x, y: t.y, seats: t.seats ?? 4, status,
    activeOrderId: t.order ?? null, lockedBy: lockLive ? t.lockBy! : null, lockedByName: lockLive ? t.lockName! : null,
  };
}
export const listTables = (f: Floor) =>
  Object.entries(f.tables).map(([id, t]) => viewTable(id, t)).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

const DEL = () => FieldValue.delete();
/** Field-path patch for one table (undefined/null values delete the field → stays compact). */
export function tablePatch(id: string, p: Partial<CompactTable>) {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [`tables.${id}.${k}`, v ?? DEL()]));
}
export const freeTable = (id: string) => tablePatch(id, { st: undefined, order: undefined, lockBy: undefined, lockName: undefined, lockUntil: undefined });
export const occupyTable = (id: string, orderId: string) => tablePatch(id, { st: 'occupied', order: orderId, lockBy: undefined, lockName: undefined, lockUntil: undefined });

export type MenuCategory = { name: string; active: boolean; sort: number };
export type StoredItem = Omit<MenuItem, 'id'> & { categoryId: string };
export interface MenuDoc { categories: Record<string, MenuCategory>; items: Record<string, StoredItem> }

export async function readMenu(tx?: Transaction): Promise<MenuDoc> {
  const d = (tx ? await tx.get(MENU()) : await MENU().get()).data() ?? {};
  return { categories: d.categories ?? {}, items: d.items ?? {} };
}

/** Short random ids for new tables/items/categories (safe as Firestore field-path keys). */
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
