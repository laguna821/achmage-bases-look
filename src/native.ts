import { TFile, type View } from 'obsidian';
import { embedShownView, queryOf } from './embedQuery.ts';

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
	/** Set the width Bases draws a column at while it is being dragged (Bases saves it on release). */
	setDragWidth: (prop: string, width: number) => boolean;
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
		setDragWidth: (prop, width) => {
			const info = rec(columnInfo?.[prop]);
			if (!info || typeof info.customWidth !== 'number') return false;
			info.customWidth = Math.max(1, Math.round(width));
			return true;
		},
	};
}

// ---- moving through the cells of a table ---------------------------------------------------

/** A cell of a table view by its place: the group, the row in that group, the column. */
export interface CellPlace {
	groupIdx: number;
	row: number;
	column: number;
}

function placeOf(value: unknown): CellPlace | null {
	const place = rec(value);
	const groupIdx = index(place?.groupIdx);
	const row = index(place?.row);
	const column = index(place?.column);
	return groupIdx !== null && row !== null && column !== null ? { groupIdx, row, column } : null;
}

export function samePlace(a: CellPlace, b: CellPlace): boolean {
	return a.groupIdx === b.groupIdx && a.row === b.row && a.column === b.column;
}

/** The table view a leaf or an embed shows now, as Bases holds it, or null for another layout. */
function tableViewOf(owner: unknown): Rec | null {
	const view = rec(controllerOf(owner)?.view);
	return view?.type === 'table' ? view : null;
}

/** The `.bases-table-container` of the table a leaf or an embed shows, without reading the table. */
export function tableContainerOf(owner: unknown): HTMLElement | null {
	return element(tableViewOf(owner)?.containerEl);
}

/** The selected cell of a table view (the one the arrow keys move from), or null. */
export function activeCellOf(owner: unknown): CellPlace | null {
	return placeOf(tableViewOf(owner)?.activeCell);
}

/** The place of a cell of a table view's rows, from its `.bases-td` element. */
export function cellPlaceOf(owner: unknown, td: HTMLElement): CellPlace | null {
	const view = tableViewOf(owner);
	if (!view || typeof view.getCellFromDom !== 'function' || typeof view.getCellIndex !== 'function') return null;
	try {
		const cell: unknown = (view.getCellFromDom as (el: HTMLElement) => unknown).call(view, td);
		return cell ? placeOf((view.getCellIndex as (cell: unknown) => unknown).call(view, cell)) : null;
	} catch {
		return null;
	}
}

/**
 * Edit the selected cell of a table, as Enter does in Bases, except that a checkbox is not ticked.
 * False when there is nothing to edit: several cells selected, a cell out of sight, a file name.
 */
export function editActiveCell(owner: unknown): boolean {
	const view = tableViewOf(owner);
	const place = placeOf(view?.activeCell);
	if (!view || !place || view.selection) return false;
	const entry = array(rec(array(rec(view.data)?.groupedData)[place.groupIdx])?.entries)[place.row];
	if (entry === undefined) return false;
	const row = array(view.rows).map(rec).find((each) => each?.entry === entry);
	const cell = rec(array(row?.cells)[place.column]);
	const renderer = rec(cell?.renderer);
	if (!renderer) return false;
	try {
		if (typeof cell?.prop === 'string' && cell.prop.startsWith('formula.') && typeof renderer.showFormulaEditor === 'function') {
			(renderer.showFormulaEditor as () => void).call(renderer);
			return true;
		}
		const editor = rec(renderer.propertyEditor);
		if (!editor || editor.type === 'checkbox' || typeof editor.focus !== 'function') return false;
		(editor.focus as (where: string) => void).call(editor, 'end');
		return true;
	} catch {
		return false;
	}
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

// ---- the view itself: zoom, scrolling, groups ------------------------------------------------
//
// `owner` is what holds a Bases controller: a Bases leaf's view, or an embed's `{ controller }`.

function controllerOf(owner: unknown): Rec | null {
	return rec(rec(owner)?.controller);
}

/** The element Bases draws a view into (`.bases-view`), in a leaf or an embed. */
export function viewElementOf(owner: unknown): HTMLElement | null {
	return element(controllerOf(owner)?.viewContainerEl);
}

/** Layout and name of the view a leaf or an embed shows now. */
export function shownViewOf(owner: unknown): { type: string | null; name: string | null } {
	return embedShownView(controllerOf(owner));
}

/**
 * The element that scrolls a view sideways: the view's own scroller in a leaf, the view element
 * of an embed (which grows with its rows and leaves the up and down to the note).
 */
export function viewScrollerOf(owner: unknown): HTMLElement | null {
	const controller = controllerOf(owner);
	const candidates = [element(rec(controller?.view)?.scrollEl), element(controller?.viewContainerEl)].filter((el): el is HTMLElement => el !== null);
	return candidates.find((el) => ['auto', 'scroll'].includes(getComputedStyle(el).overflowX)) ?? candidates[0] ?? null;
}

/**
 * The width a view's content needs, in the view's own pixels, or null when it has no width of its
 * own (cards and lists flow into the width they get). Bases sets the full width of a table or a
 * kanban board on its container, which still stretches to fill a wider view: that width is used,
 * so the content is measured right however wide the view is now.
 */
export function contentWidthOf(scroller: HTMLElement): number | null {
	let declared = 0;
	for (const child of Array.from(scroller.children)) {
		const width = child.instanceOf(HTMLElement) ? child.style.width : '';
		if (width.endsWith('px')) declared = Math.max(declared, parseFloat(width) || 0);
	}
	if (declared > 0) {
		const style = getComputedStyle(scroller);
		return Math.ceil(declared + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0));
	}
	return scroller.scrollWidth > scroller.clientWidth + 1 ? scroller.scrollWidth : null;
}

/** The element that scrolls a leaf's view up and down, or null in an embed (the note scrolls). */
export function viewVerticalScrollerOf(owner: unknown): HTMLElement | null {
	const scroller = element(rec(controllerOf(owner)?.view)?.scrollEl);
	// An embed's view scrolls sideways, which makes it say it scrolls up and down too: it has to.
	return scroller && ['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1 ? scroller : null;
}

/** Ask a view to measure its room again, as after a resize (its zoom changed). */
export function relayoutView(owner: unknown): void {
	const controller = controllerOf(owner);
	if (typeof controller?.onResize !== 'function') return;
	try {
		(controller.onResize as () => void).call(controller);
	} catch {
		// The view measures itself on its next redraw.
	}
}

export interface ViewGroup {
	/** The heading Bases keeps for the group (drawn or scrolled out of sight), or null. */
	heading: HTMLElement | null;
	/** Notes in the group. */
	count: number;
	/** The group value as text, as the heading shows it. */
	value: string;
}

function keyText(key: Rec | null): string {
	const value = key?.data;
	if (value === null || value === undefined) return '';
	if (typeof value === 'string') return value;
	return typeof key?.toString === 'function' ? (key as { toString(): string }).toString() : '';
}

/**
 * The groups of the view a leaf or an embed shows, with the headings Bases keeps for them: card
 * and list groups hold their own heading, table groups draw theirs at the top of their block.
 */
export function readViewGroups(owner: unknown): ViewGroup[] {
	const inner = rec(controllerOf(owner)?.view);
	const data = array(rec(inner?.data)?.groupedData);
	return array(inner?.groups).map((raw, i) => {
		const block = rec(raw);
		const group = rec(block?.group) ?? rec(data[i]);
		const heading = element(block?.groupHeadingEl)
			?? element(block?.tableEl)?.find(':scope > .bases-group-heading')
			?? element(block?.containerEl)?.find('.bases-group-heading')
			?? null;
		return { heading: heading?.hasClass('bases-group-heading') ? heading : null, count: array(group?.entries).length, value: keyText(rec(group?.key)) };
	});
}

/** A function an object (or a class, for its static functions) holds under a name. */
function fnOf(value: unknown, name: string): ((...args: unknown[]) => unknown) | null {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
	const fn: unknown = (value as Record<string, unknown>)[name];
	return typeof fn === 'function' ? (fn as (...args: unknown[]) => unknown) : null;
}

interface GroupFolds {
	/** The groups of the view that have a heading to fold. */
	groups: unknown[];
	folded: (group: unknown) => boolean;
	/** Fold (or unfold) every group, as clicking each heading would. */
	setAll: (fold: boolean) => void;
}

/**
 * How Bases folds the groups of the view on screen, or null. Bases keeps the folded groups on this
 * device, per base and view: changed here at once and saved once, or else group by group with the
 * view's own toggle, as a click on each heading does.
 */
function groupFolds(owner: unknown): GroupFolds | null {
	const controller = controllerOf(owner);
	const inner = rec(controller?.view);
	if (!controller || !inner) return null;
	// A group without a value (notes missing the property) has no heading and cannot be folded.
	const groups = array(rec(inner.data)?.groupedData).filter((group) => Boolean(rec(group)?.key));
	if (groups.length === 0) return null;
	const getId = fnOf(inner.constructor, 'getGroupId');
	const getFolds = fnOf(controller, 'getGroupFolds');
	const saveFolds = fnOf(controller, 'saveGroupFolds');
	const changed = fnOf(inner, 'onGroupCollapsedChange');
	const folds: unknown = getFolds?.call(controller);
	if (getId && saveFolds && changed && folds instanceof Set) {
		const ids = new Map(groups.map((group) => [group, getId(group)]));
		if ([...ids.values()].every((id) => typeof id === 'string')) {
			return {
				groups,
				folded: (group) => folds.has(ids.get(group)),
				setAll: (fold) => {
					for (const id of ids.values()) {
						if (fold) folds.add(id);
						else folds.delete(id);
					}
					saveFolds.call(controller);
					for (const group of groups) changed.call(inner, group);
				},
			};
		}
	}
	const isFolded = fnOf(inner, 'isGroupCollapsed');
	const toggle = fnOf(inner, 'toggleGroupCollapsed');
	if (!isFolded || !toggle) return null;
	return {
		groups,
		folded: (group) => isFolded.call(inner, group) === true,
		setAll: (fold) => {
			for (const group of groups) if ((isFolded.call(inner, group) === true) !== fold) toggle.call(inner, group);
		},
	};
}

/** True when the groups of the view on screen can be folded all at once here. */
export function canFoldGroups(owner: unknown): boolean {
	return groupFolds(owner) !== null;
}

/** True when every group of the view is folded. */
export function allGroupsFolded(owner: unknown): boolean {
	const state = groupFolds(owner);
	return state !== null && state.groups.every((group) => state.folded(group));
}

/**
 * Fold (true) or unfold (false) every group of the view, as clicking each heading would. Bases
 * keeps the folds on this device, as it does for a click. False when it cannot be done here.
 */
export function foldAllGroups(owner: unknown, fold: boolean): boolean {
	const state = groupFolds(owner);
	if (!state) return false;
	try {
		state.setAll(fold);
	} catch {
		return false;
	}
	return true;
}

/** The base file an embedded base shows, or null for a base written in a code block. */
export function embedBaseFile(controller: unknown): TFile | null {
	const file = queryOf(controller)?.file;
	return file instanceof TFile ? file : null;
}

/** The note (or canvas) a base is embedded in. */
export function embedNoteFile(controller: unknown): TFile | null {
	const file = rec(controller)?.currentFile;
	return file instanceof TFile ? file : null;
}

export { editEmbedQuery, embedQueryText, embedShownView, embedViewSetting } from './embedQuery.ts';
