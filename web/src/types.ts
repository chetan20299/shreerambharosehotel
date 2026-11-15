export type Role = 'admin' | 'waiter';
export type Lang = 'en' | 'gu' | 'hi';
export type PriceCategory = 'ac' | 'nonac';

export interface User {
  id: string; username: string; displayName: string; role: Role; active: boolean; language?: Lang;
  createdAt?: string | null; lastLoginAt?: string | null;
}
export interface MenuCategory { id: string; name: string; active: boolean; sort: number }
export interface MenuItem {
  id: string; name: string; price: number; acPrice: number | null; type: 'fixed' | 'custom'; isThali: boolean;
  active: boolean; description: string; sort: number; categoryId: string;
}
export interface MenuData { categories: MenuCategory[]; items: MenuItem[] }
/** Price for a hall: AC price if set, otherwise the Non-AC price. */
export const priceFor = (m: Pick<MenuItem, 'price' | 'acPrice'>, cat: PriceCategory) => (cat === 'ac' ? m.acPrice ?? m.price : m.price);

export type TableStatus = 'available' | 'in_progress' | 'occupied' | 'billed';
export interface Table {
  id: string; label: string; sectionId: string; x: number; y: number; seats: number; status: TableStatus;
  activeOrderId: string | null; lockedBy: string | null; lockedByName: string | null;
}
export interface Section { id: string; name: string; priceCategory?: PriceCategory; cols?: number; rows?: number }
export interface Fixture { id: string; sectionId: string; type: 'entry' | 'exit' | 'door' | 'kitchen'; x: number; y: number }
export interface OrderItem {
  menuItemId: string; name: string; type: 'fixed' | 'custom'; isThali: boolean;
  quantity: number; unitPrice: number; amount: number; description: string;
}
export interface Order {
  id: string; billNo: string; date: string; time: string; waiterId: string; waiterName: string;
  tableId: string; tableLabel: string; items: OrderItem[]; total: number;
  status: 'confirmed' | 'billed' | 'cancelled'; createdAt: string; printCount?: number; cancelReason?: string;
  offline?: boolean; conflict?: boolean; priceCategory?: PriceCategory;
}
export interface Bucket { key: string; label: string; orders: number; amount: number }
export interface Summary {
  orderCount: number; cancelledCount: number; totalAmount: number; thaliCount: number; extraAmount: number;
  byItem: { menuItemId: string; name: string; isThali: boolean; type: string; quantity: number; amount: number }[];
  byDay: Bucket[]; byWaiter: Bucket[]; byTable: Bucket[]; byCategory?: Bucket[]; byHour?: Bucket[];
}
export interface Settings {
  hotelName: string; address: string; phone: string; gstin: string; footer: string; paperWidth: 58 | 80;
}
export interface MonthlySummary extends Summary { month: string; updatedAt?: string }
