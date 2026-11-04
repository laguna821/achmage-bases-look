import { TFile, type View } from 'obsidian';
import { queryOf } from './embedQuery.ts';

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

/**
 * Notes in each group of the view shown in a Bases leaf, keyed by the group value as text
 * ('' for the group without a value). Null when the view's data cannot be read.
 */
export function readGroupFiles(view: View): Map<string, TFile[]> | null {
	const data = rec(rec(rec(rec(view)?.controller)?.view)?.data);
	if (!data || !('groupedData' in data)) return null;
	const result = new Map<string, TFile[]>();
	for (const raw of array(data.groupedData)) {
		const group = rec(raw);
		const key = rec(group?.key);
		const value = key?.data;
		// The heading shows the value's text; lists and links have their own toString().
		const text = value === null || value === undefined ? ''
			: typeof value === 'string' ? value
				: typeof key?.toString === 'function' ? (key as { toString(): string }).toString() : '';
		const files = array(group?.entries).map((entry) => rec(entry)?.file).filter((file): file is TFile => file instanceof TFile);
		result.set(text, [...(result.get(text) ?? []), ...files]);
	}
	return result;
}

export interface NativeTableCell {
	el: HTMLElement;
	/** Property id of the column. */
	prop: string;
	/**
	 * False for a column scrolled out of sight: Bases keeps its cell, rendered, but takes it out
	 * of the page until the column scrolls back.
	 */
	drawn: boolean;
}

export interface NativeTableRow {
	file: TFile;
	el: HTMLElement;
	/** A cell for every column, drawn or not. */
	cells: NativeTableCell[];
}

/** A table view on screen, read from the objects Obsidian keeps for it. */
export interface NativeTable {
	/** The `.bases-table-container` element. */
	containerEl: HTMLElement;
	/** Width of the part of the table on screen. */
	visibleWidth: number;
	viewName: string | null;
	/** Property ids of the columns, in order. */
	properties: string[];
	/** The header row, and a header cell for every column, drawn or not. */
	headerEl: HTMLElement | null;
	header: NativeTableCell[];
	/** Rows that are drawn (rows scrolled out of sight have none). */
	rows: NativeTableRow[];
	/** The selected cells, as note paths and property ids, or null. */
	selection: { paths: string[]; props: string[] } | null;
	/** The cell with the keyboard focus, or null. */
	active: { path: string; prop: string } | null;
	/** Row height as the view holds it now, saved or not ('' is short). */
	rowHeight: unknown;
	/** Name of a column as its header shows it. */
	displayName: (prop: string) => string;
	/** Every note of the view with its values as text, for rows that are not drawn. */
	entries: () => { path: string; text: (prop: string) => string }[];
	/** The width saved for a column, or 0 when Obsidian sizes it. */
	customWidth: (prop: string) => number;
	/** The width Bases draws a column at, drawn or not: its saved width, else its content width within Bases' limits. */
	columnWidth: (prop: string) => number;
	/** Give a column back Obsidian's automatic width, as its own double-click does. False when not possible. */
	resetWidth: (prop: string) => boolean;
}

interface ValueSource {
	getValue(prop: string): unknown;
}

interface ViewConfig {
	get(key: string): unknown;
	getDisplayName(prop: string): unknown;
}

interface TableInternals {
	resetColumnResize(prop: string): void;
}

function hasValues(entry: Rec): entry is Rec & ValueSource {
	return typeof entry.getValue === 'function';
}

function isViewConfig(config: Rec | null): config is Rec & ViewConfig {
	return config !== null && typeof config.get === 'function' && typeof config.getDisplayName === 'function';
}

/** A value of a note as text ('' for none), as Bases shows it. */
function valueText(entry: Rec, prop: string): string {
	if (!hasValues(entry)) return '';
	try {
		const value = entry.getValue(prop);
		if (value === null || value === undefined) return '';
		const text = typeof value === 'string' ? value : (value as { toString(): string }).toString();
		return text === 'null' ? '' : text;
	} catch {
		return '';
	}
}

function cellsOf(owner: unknown): NativeTableCell[] {
	const cells: NativeTableCell[] = [];
	for (const raw of array(rec(owner)?.cells)) {
		const cell = rec(raw);
		const el = element(cell?.el);
		const prop = cell?.prop;
		if (el && typeof prop === 'string') cells.push({ el, prop, drawn: el.isConnected });
	}
	return cells;
}

function index(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The table view shown in a Bases leaf or a base embedded in a note: its drawn header cells and
 * rows, selection and column widths. `owner` is the leaf's view, or an embed's `{ controller }`.
 * Null when the view is not a table, or its objects look different than expected.
 */
export function readNativeTable(owner: unknown): NativeTable | null {
	const controller = rec(rec(owner)?.controller);
	const inner = rec(controller?.view);
	if (!controller || !inner || inner.type !== 'table') return null;
	const containerEl = element(inner.containerEl);
	const data = rec(inner.data);
	if (!containerEl || !data) return null;
	const properties = array(data.properties).filter((prop): prop is string => typeof prop === 'string');
	const rows: NativeTableRow[] = [];
	for (const raw of array(inner.rows)) {
		const row = rec(raw);
		const el = element(row?.el);
		const file = rec(row?.entry)?.file;
		if (el && el.isConnected && file instanceof TFile) rows.push({ file, el, cells: cellsOf(row) });
	}
	const groups = array(data.groupedData);
	const fileAt = (group: number, row: number): TFile | null => {
		const file = rec(array(rec(groups[group])?.entries)[row])?.file;
		return file instanceof TFile ? file : null;
	};

	let selection: NativeTable['selection'] = null;
	const range = rec(inner.selection);
	const group = index(range?.groupIdx);
	const top = index(range?.top);
	const bottom = index(range?.bottom);
	const start = index(range?.start);
	const end = index(range?.end);
	if (group !== null && top !== null && bottom !== null && start !== null && end !== null) {
		const paths: string[] = [];
		for (let row = top; row <= bottom; row++) {
			const file = fileAt(group, row);
			if (file) paths.push(file.path);
		}
		const props = properties.slice(start, end + 1);
		if (paths.length > 0 && props.length > 0) selection = { paths, props };
	}

	let active: NativeTable['active'] = null;
	const focus = rec(inner.activeCell);
	const activeGroup = index(focus?.groupIdx);
	const activeRow = index(focus?.row);
	const activeColumn = index(focus?.column);
	if (activeGroup !== null && activeRow !== null && activeColumn !== null) {
		const file = fileAt(activeGroup, activeRow);
		const prop = properties[activeColumn];
		if (file && prop) active = { path: file.path, prop };
	}

	const config = rec(inner.config);
	const viewConfig = isViewConfig(config) ? config : null;
	const columnInfo = rec(inner.columnInfo);
	return {
		containerEl,
		visibleWidth: (element(inner.scrollEl) ?? containerEl.parentElement ?? containerEl).clientWidth,
		viewName: typeof controller.viewName === 'string' ? controller.viewName : null,
		properties,
		headerEl: element(rec(inner.header)?.el),
		header: cellsOf(inner.header),
		rows,
		selection,
		active,
		rowHeight: viewConfig?.get('rowHeight'),
		displayName: (prop) => {
			const name = viewConfig?.getDisplayName(prop);
			return typeof name === 'string' ? name : prop.replace(/^(note|formula|file)\./, '');
		},
		entries: () => array(data.data).flatMap((raw) => {
			const entry = rec(raw);
			const file = entry?.file;
			return entry && file instanceof TFile ? [{ path: file.path, text: (prop: string) => valueText(entry, prop) }] : [];
		}),
		customWidth: (prop) => {
			const width = rec(columnInfo?.[prop])?.customWidth;
			return typeof width === 'number' ? width : 0;
		},
		columnWidth: (prop) => {
			const info = rec(columnInfo?.[prop]);
			const number = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
			const min = number(inner.minColWidth, 100);
			const custom = number(info?.customWidth, 0);
			if (custom > 0) return Math.max(min, custom);
			const content = Math.max(number(info?.contentWidth, 0), number(info?.headerWidth, 0)) + 1;
			return Math.min(number(inner.maxColWidth, 600), Math.max(min, content));
		},
		resetWidth: (prop) => {
			if (typeof inner.resetColumnResize !== 'function') return false;
			(inner as unknown as TableInternals).resetColumnResize(prop);
			return true;
		},
	};
}

// ---- bases embedded in notes -------------------------------------------------------------
//
// A base embedded in a note (`![[file.base#view]]`), written in a ```base code block, shown in a
// hover preview or on a canvas card has the same controller as a Bases leaf, drawn into its own
// `.bases-embed` element. Obsidian keeps these controllers among the children of the components
// that show them; nothing points from the element back to its controller, so they are found by
// walking down from the workspace leaves.

/** Enough for every component of a workspace; a walk that gets this far stops. */
const WALK_LIMIT = 50000;

/**
 * The `.bases-embed` element a Bases controller draws into, while it still draws there. Null for
 * anything else, including the controller of a Bases leaf. An embed is found as soon as it is
 * drawn, while it still reads its base (its query comes a moment later).
 */
export function embedElementOf(controller: unknown): HTMLElement | null {
	const value = rec(controller);
	const view = element(value?.viewContainerEl);
	if (!value || !view || !view.isConnected || typeof value.getViewConfig !== 'function' || typeof value.setQuery !== 'function') return null;
	const host = view.parentElement;
	return host?.hasClass('bases-embed') ? host : null;
}

/**
 * Controllers of the embedded bases on screen, by their `.bases-embed` element, found from the
 * given components (workspace leaves and their views): their children, the hover previews they
 * show, and the cards of a canvas.
 */
export function findEmbedControllers(roots: unknown[]): Map<HTMLElement, unknown> {
	const found = new Map<HTMLElement, unknown>();
	const seen = new Set<unknown>();
	const stack = [...roots];
	while (stack.length > 0 && seen.size < WALK_LIMIT) {
		const value = rec(stack.pop());
		if (!value || seen.has(value)) continue;
		seen.add(value);
		const host = embedElementOf(value);
		if (host) found.set(host, value);
		for (const child of array(value._children)) stack.push(child);
		if (value.hoverPopover) stack.push(value.hoverPopover);
		const nodes = rec(value.canvas)?.nodes;
		if (nodes instanceof Map) for (const node of nodes.values()) stack.push(rec(node)?.child);
	}
	return found;
}

/** The base file an embedded base shows, or null for a base written in a code block. */
export function embedBaseFile(controller: unknown): TFile | null {
	const file = queryOf(controller)?.file;
	return file instanceof TFile ? file : null;
}

export { editEmbedQuery, embedQueryText, embedShownView, embedViewSetting } from './embedQuery.ts';
