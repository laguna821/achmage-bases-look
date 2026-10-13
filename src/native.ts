import { TFile, type View } from 'obsidian';

// Bases has no public API for decorating its built-in views, so this module reads the
// view objects Obsidian 1.13–1.14 keep in memory. Every step is checked; when the shape
// changes, `readNativeView` returns null and the plugin quietly stops decorating while
// the official-API features (base settings, thumbnail window, commands) keep working.

export type NativeType = 'cards' | 'kanban' | 'table' | 'list';

export interface NativeItem {
	file: TFile;
	/** Card or row element. */
	el: HTMLElement;
	/** Card cover element (cards and kanban) when the view shows images. */
	cover: HTMLElement | null;
}

export interface NativeView {
	type: NativeType;
	items: NativeItem[];
	/** Name of the view shown in the toolbar. */
	viewName: string | null;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
	return typeof value === 'object' && value !== null ? (value as Rec) : null;
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function element(value: unknown): HTMLElement | null {
	return value instanceof HTMLElement ? value : null;
}

function toItem(raw: unknown, coverKey: string | null): NativeItem | null {
	const item = rec(raw);
	const el = element(item?.el);
	const entry = rec(item?.entry);
	const file = entry?.file;
	if (!item || !el || !(file instanceof TFile)) return null;
	return { file, el, cover: coverKey ? element(item[coverKey]) : null };
}

export function readNativeView(view: View): NativeView | null {
	const controller = rec(rec(view)?.controller);
	const inner = rec(controller?.view);
	const type = inner?.type;
	if (!controller || !inner || typeof type !== 'string') return null;
	const viewName = typeof controller.viewName === 'string' ? controller.viewName : null;
	let raws: unknown[];
	let coverKey: string | null = null;
	switch (type) {
		case 'kanban':
			raws = array(inner.columns).flatMap((column) => array(rec(column)?.items));
			coverKey = 'coverEl';
			break;
		case 'cards':
			raws = array(inner.items);
			coverKey = 'coverEl';
			break;
		case 'table':
			raws = array(inner.rows);
			break;
		case 'list':
			raws = array(inner.groups).flatMap((group) => array(rec(group)?.rows));
			break;
		default:
			return null;
	}
	const items: NativeItem[] = [];
	for (const raw of raws) {
		const item = toItem(raw, coverKey);
		if (item && item.el.isConnected) items.push(item);
	}
	return { type, items, viewName };
}

/** True while Obsidian is dragging one of its own items (a card, a file from the explorer, …). */
export function isInternalDrag(app: unknown): boolean {
	const dragManager = rec(rec(app)?.dragManager);
	return Boolean(dragManager?.draggable);
}

/** Text of a group heading's value, as the user sees it. Null for hidden measuring copies. */
export function groupValue(heading: HTMLElement): string | null {
	if (heading.closest('[style*="opacity: 0"]')) return null;
	return heading.find('.bases-group-value')?.textContent?.trim() ?? '';
}

/** Group values shown in a view, in screen order, without duplicates. */
export function visibleGroups(root: HTMLElement): string[] {
	const seen: string[] = [];
	for (const heading of root.findAll('.bases-group-heading')) {
		const value = groupValue(heading);
		if (value !== null && !seen.includes(value)) seen.push(value);
	}
	return seen;
}

export interface GroupSection {
	/** Text of the group value, as shown. */
	value: string;
	heading: HTMLElement;
	/** The block that holds the group's cards or rows (may not contain the heading). */
	section: HTMLElement;
}

const GROUP_SECTION_SELECTOR = '.bases-kanban-column, .bases-cards-group, .bases-table, .bases-list-group';

/**
 * Pairs every visible group heading with the block that holds that group. Card and list
 * views keep sticky headings outside the block, so the view's own group list is used
 * when available; otherwise the heading's nearest group block.
 */
export function readGroupSections(view: View, root: HTMLElement): GroupSection[] {
	const inner = rec(rec(rec(view)?.controller)?.view);
	const result: GroupSection[] = [];
	const seen = new Set<HTMLElement>();
	const groups = array(inner?.columns).concat(array(inner?.groups));
	for (const raw of groups) {
		const group = rec(raw);
		const section = element(group?.containerEl) ?? element(group?.tableEl);
		const heading = element(group?.groupHeadingEl) ?? element(group?.headerEl)?.find('.bases-group-heading') ?? section?.find('.bases-group-heading') ?? null;
		if (!section || !heading || !section.isConnected) continue;
		const value = groupValue(heading);
		if (value === null) continue;
		seen.add(heading);
		result.push({ value, heading, section });
	}
	for (const heading of root.findAll('.bases-group-heading')) {
		if (seen.has(heading)) continue;
		const section = heading.closest<HTMLElement>(GROUP_SECTION_SELECTOR);
		const value = groupValue(heading);
		if (section && value !== null) result.push({ value, heading, section });
	}
	return result;
}
