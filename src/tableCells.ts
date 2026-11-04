import { Menu, Notice, Platform } from 'obsidian';
import { tableColumnWidth } from './baseConfig.ts';
import { closeFormatPanel, openFormatPanel, type FormatScope } from './formatUi';
import { strings } from './i18n';
import { looksLikeImage } from './images.ts';
import { readNativeTable, type NativeTable } from './native';
import {
	ALIGNS, fitRowPreset, hasFormat, isEmptyFormat, MIN_COLUMN_WIDTH, narrowestFit, nearestRowPreset, rowPixels, rowPreset, shownCell, shownHeader,
	type FormatTarget, type RowPreset, type ShownFormat, type TableFormat, type Theme,
} from './tableFormat.ts';
import type { TableHost } from './tableHost';
import type { BaseInfo } from '../main';

/** Marks a cell this plugin formats; the classes below say how. */
const FMT = 'achmage-look-fmt';
const FILL = 'achmage-look-fmt-fill';
const TEXT = 'achmage-look-fmt-text';
const BOLD = 'achmage-look-fmt-bold';
const ITALIC = 'achmage-look-fmt-italic';
const alignClass = (align: string) => `achmage-look-fmt-${align}`;
const FMT_CLASSES = [FMT, FILL, TEXT, BOLD, ITALIC, ...ALIGNS.map(alignClass)];
const FILL_VAR = '--achmage-look-fmt-fill';
const TEXT_VAR = '--achmage-look-fmt-text';
/** On the view while the pointer is on the line under a row. */
const EDGE = 'achmage-look-row-edge';
const MEASURE_HEIGHT = 'achmage-look-measure-height';
const MEASURE_WIDTH = 'achmage-look-measure-width';
const GUIDE = 'achmage-look-row-guide';
/** How close to the line under a row the pointer has to be, in pixels. */
const EDGE_SIZE = 4;
/** Rows that are not drawn are measured from their text, up to this many. */
const ESTIMATE_LIMIT = 2000;
/** Links keep their own right-click menu. */
const OWN_MENU = 'a, .internal-link, .external-link, .bases-table-header-resizer';
/**
 * Fields keep theirs (spelling, cut, copy, paste) while they are being edited. Bases draws every
 * text cell as an editable field, edited or not.
 */
const FIELD = 'input, textarea, select, [contenteditable="true"]';

export function themeOf(el: HTMLElement): Theme {
	return el.doc.body.hasClass('theme-dark') ? 'dark' : 'light';
}

/** The field of the table a target is in, if any. */
function fieldAt(target: Element, root: HTMLElement): Element | null {
	const field = target.closest(FIELD);
	return field !== null && field !== root && root.contains(field) ? field : null;
}

/** A field that holds the keyboard focus: it is being edited. */
function editing(field: Element): boolean {
	return field.contains(field.doc.activeElement);
}

function clearCell(el: HTMLElement): void {
	el.removeClasses(FMT_CLASSES);
	el.setCssProps({ [FILL_VAR]: '', [TEXT_VAR]: '' });
}

/** A cell that shows an image: its size follows the row, not its content. */
function holdsImage(cell: HTMLElement): boolean {
	return cell.find('img') !== null;
}

/** Height of a short row in this table: the theme's `--bases-table-row-height`, 30px by default. */
function rowUnit(container: HTMLElement): number {
	const value = parseFloat(getComputedStyle(container).getPropertyValue('--bases-table-row-height'));
	return Number.isFinite(value) && value > 0 ? value : 30;
}

function rowLabel(preset: RowPreset): string {
	const t = strings();
	return { '': t.rowShort, medium: t.rowMedium, tall: t.rowTall, extra: t.rowExtra }[preset];
}

/**
 * Measure a cell. Bases keeps the cells of columns out of sight rendered but out of the page; such
 * a cell joins its row for the moment of the measurement only, before anything is painted.
 */
function measure<T>(parent: HTMLElement | null, cell: HTMLElement, run: () => T): T {
	if (cell.isConnected || !parent) return run();
	parent.appendChild(cell);
	try {
		return run();
	} finally {
		cell.detach();
	}
}

/** The cell a right-click or a command starts from. */
interface CellContext {
	/** The table and where its changes go: a Bases leaf, or a base embedded in a note. */
	host: TableHost;
	viewName: string;
	root: HTMLElement;
	table: NativeTable;
	prop: string;
	/** Note of the row, or null on a header cell. */
	path: string | null;
	/** The selection, when the cell is part of it. */
	selection: { paths: string[]; props: string[] } | null;
}

/** How text is set in this table, for values in rows that are not drawn. */
interface TextMetrics {
	font: string;
	/** Room around the text in a cell, left and right together. */
	padding: number;
	lineHeight: number;
}

/**
 * Table formats on screen and the table tools: right-click items, fitting columns and rows, and
 * the line under a row as a handle. Everything here works on table views only, in Bases leaves
 * and in bases embedded in notes alike: `hostOf` says which table a view container or an embed
 * element shows, and where its changes go.
 */
export class TableCells {
	private readonly hostOf: (root: HTMLElement) => TableHost | null;
	private canvas: HTMLCanvasElement | null = null;
	private guide: HTMLElement | null = null;
	/** The body cell under the last right-click, for the menu Obsidian opens on a selection. */
	private rightClick: { root: HTMLElement; td: HTMLElement; x: number; y: number; time: number } | null = null;
	/**
	 * The field under the last right button press, and whether it was being edited before the
	 * press: pressing the right button on a field gives it the focus before its menu opens.
	 */
	private rightPress: { field: Element; editing: boolean; time: number } | null = null;
	/** A row height drag is going on. */
	private dragging = false;
	/** Swallow the click that ends a press on the line under a row. */
	private swallowClick = false;

	constructor(hostOf: (root: HTMLElement) => TableHost | null) {
		this.hostOf = hostOf;
	}

	/**
	 * Show the formats of the table on screen. Runs on every redraw: Bases reuses cells while
	 * scrolling, so each cell gets the format of the note and column it shows now. Cells of
	 * columns out of sight get theirs too, so they show it as soon as they scroll in. `owner` is
	 * what `readNativeTable` reads: a leaf's view, or an embed's controller holder.
	 */
	decorate(owner: unknown, root: HTMLElement, format: TableFormat | null): void {
		const shown = new Set<HTMLElement>();
		const table = format && !isEmptyFormat(format) ? readNativeTable(owner) : null;
		if (table && format) {
			const theme = themeOf(root);
			for (const cell of table.header) this.paint(cell.el, shownHeader(format, cell.prop, theme), shown);
			for (const row of table.rows) {
				for (const cell of row.cells) this.paint(cell.el, shownCell(format, row.file.path, cell.prop, theme), shown);
			}
		}
		for (const el of root.findAll(`.${FMT}`)) if (!shown.has(el)) clearCell(el);
	}

	private paint(el: HTMLElement, format: ShownFormat, shown: Set<HTMLElement>): void {
		if (!format.fill && !format.text && !format.bold && !format.italic && !format.align) {
			if (el.hasClass(FMT)) clearCell(el);
			return;
		}
		shown.add(el);
		if (!el.hasClass(FMT)) el.addClass(FMT);
		el.toggleClass(FILL, format.fill !== null);
		el.toggleClass(TEXT, format.text !== null);
		el.toggleClass(BOLD, format.bold);
		el.toggleClass(ITALIC, format.italic);
		for (const align of ALIGNS) el.toggleClass(alignClass(align), format.align === align);
		const fill = format.fill ?? '';
		const text = format.text ?? '';
		if (el.style.getPropertyValue(FILL_VAR) !== fill || el.style.getPropertyValue(TEXT_VAR) !== text) {
			el.setCssProps({ [FILL_VAR]: fill, [TEXT_VAR]: text });
		}
	}

	/** Take every format off a view: the plugin stops, or the view is no longer a table. */
	clear(root: HTMLElement): void {
		root.findAll(`.${FMT}`).forEach(clearCell);
		root.removeClass(EDGE);
	}

	destroy(): void {
		closeFormatPanel();
		this.guide?.detach();
		this.guide = null;
	}

	private contextAt(root: HTMLElement, td: HTMLElement): CellContext | null {
		const host = this.hostOf(root);
		const table = host?.table();
		if (!host || !table?.viewName) return null;
		const known = { host, viewName: table.viewName, root, table };
		if (td.closest('.bases-thead')) {
			const prop = table.header.find((cell) => cell.el === td)?.prop;
			return prop ? { ...known, prop, path: null, selection: null } : null;
		}
		if (!td.closest('.bases-tbody')) return null;
		for (const row of table.rows) {
			const cell = row.cells.find((each) => each.el === td);
			if (!cell) continue;
			const { selection } = table;
			const inSelection = selection !== null && selection.paths.includes(row.file.path) && selection.props.includes(cell.prop);
			return { ...known, prop: cell.prop, path: row.file.path, selection: inSelection ? selection : null };
		}
		return null;
	}

	// ---- right-click -------------------------------------------------------------------------

	/**
	 * A link inside the table, or a field of it that was being edited: they keep their own menu.
	 * Only the table's own elements count; a base embedded in the editor sits inside the editor's
	 * editable area. Bases draws every text cell as a field, so a field only keeps its menu while
	 * it is edited, as it was before the right button was pressed.
	 */
	private inOwnMenu(target: Element, root: HTMLElement): boolean {
		const link = target.closest(OWN_MENU);
		if (link !== null && link !== root && root.contains(link)) return true;
		const field = fieldAt(target, root);
		if (!field) return false;
		const press = this.rightPress;
		return press && press.field === field && Date.now() - press.time < 2000 ? press.editing : editing(field);
	}

	/**
	 * The right button goes down on a table: note whether the field under it was being edited. A
	 * field that was not keeps from being edited (and from showing its suggestions): its cell
	 * gets the table's menu, as any other cell.
	 */
	private notePress(event: PointerEvent, root: HTMLElement): void {
		const field = event.target instanceof Element ? fieldAt(event.target, root) : null;
		this.rightPress = field ? { field, editing: editing(field), time: Date.now() } : null;
		if (this.rightPress && !this.rightPress.editing) event.preventDefault();
	}

	/**
	 * Right-click on a header or body cell: add the format and fit items to the menu. This runs
	 * after Obsidian's own handlers, so `Menu.forEvent` hands back the menu they filled (header
	 * menu, selection menu), or a new one where Obsidian shows none.
	 */
	onContextMenu(event: MouseEvent, root: HTMLElement): void {
		const target = event.target;
		if (!(target instanceof Element) || this.inOwnMenu(target, root)) return;
		const td = target.closest<HTMLElement>('.bases-td');
		if (!td || !root.contains(td)) return;
		const context = this.contextAt(root, td);
		if (context) this.fillMenu(Menu.forEvent(event), context, { x: event.clientX, y: event.clientY });
	}

	/**
	 * Note the body cell of a right-click before Obsidian handles it. On a selection, Obsidian
	 * shows its own menu and stops the event; it then announces that menu as a `file-menu` or
	 * `files-menu` from `bases-context-menu`, where `onSelectionMenu` adds the items.
	 */
	noteRightClick(event: MouseEvent, root: HTMLElement): void {
		const target = event.target;
		const td = target instanceof Element && !this.inOwnMenu(target, root) ? target.closest<HTMLElement>('.bases-tbody .bases-td') : null;
		this.rightClick = td && root.contains(td) ? { root, td, x: event.clientX, y: event.clientY, time: Date.now() } : null;
	}

	/** Obsidian's menu for selected table cells: add the format and fit items. */
	onSelectionMenu(menu: Menu, source: string): void {
		const last = this.rightClick;
		this.rightClick = null;
		if (source !== 'bases-context-menu' || !last || !last.td.isConnected || Date.now() - last.time > 1000) return;
		const context = this.contextAt(last.root, last.td);
		if (context?.selection) this.fillMenu(menu, context, { x: last.x, y: last.y });
	}

	/** On phones the header menu opens with a tap: add the same items there. */
	onTap(event: MouseEvent, root: HTMLElement): void {
		if (!Platform.isMobile || !(event.target instanceof Element) || !event.target.closest('.bases-thead .bases-td')) return;
		this.onContextMenu(event, root);
	}

	private fillMenu(menu: Menu, context: CellContext, at: { x: number; y: number }): void {
		const t = strings();
		const header = context.path === null;
		// Obsidian's own sections: next to “Hide column” in the header menu, under “Resize” (empty
		// on desktop) for sizes, and in the view section of the selection menu.
		const section = header ? 'action' : 'view';
		const sizes = header ? 'resize' : 'view';
		const props = context.selection?.props ?? [context.prop];
		menu.addItem((item) => item.setSection(section).setTitle(header ? t.formatHeader : t.formatCells).setIcon('paintbrush')
			.onClick(() => this.openFormat(context, at)));
		menu.addItem((item) => item.setSection(sizes).setTitle(props.length > 1 ? t.fitColumns : t.fitColumn).setIcon('move-horizontal')
			.onClick(() => void this.fitColumns(context.host, props)));
		menu.addItem((item) => item.setSection(sizes).setTitle(t.fitRows).setIcon('move-vertical')
			.onClick(() => void this.fitRows(context.host)));
		if (header && context.table.customWidth(context.prop) > 0) {
			menu.addItem((item) => item.setSection(sizes).setTitle(t.autoWidth).setIcon('rotate-ccw')
				.onClick(() => this.resetWidth(context)));
		}
		const own = this.ownTarget(context);
		if (hasFormat(context.host.format(context.viewName), own)) {
			menu.addItem((item) => item.setSection(sizes).setTitle(header ? t.clearHeaderFormat : t.clearCellFormat).setIcon('eraser')
				.onClick(() => void context.host.clearFormat(context.viewName, own)));
		}
	}

	/** The header cell, the selected cells, or the one cell a menu was opened on. */
	private ownTarget(context: CellContext): FormatTarget {
		if (context.path === null) return { kind: 'header', props: [context.prop] };
		const { selection } = context;
		if (!selection) return { kind: 'cell', cells: [[context.path, context.prop]] };
		return { kind: 'cell', cells: selection.paths.flatMap((path) => selection.props.map((prop): [string, string] => [path, prop])) };
	}

	private openFormat(context: CellContext, at: { x: number; y: number }): void {
		const t = strings();
		const scopes: FormatScope[] = [];
		if (context.path === null) {
			scopes.push({ label: t.scopeHeader, target: { kind: 'header', props: [context.prop] } });
			scopes.push({ label: t.scopeColumnCells, target: { kind: 'column', props: [context.prop] } });
		} else {
			const { selection } = context;
			const cells = this.ownTarget(context);
			if (cells.kind === 'cell' && cells.cells.length > 1) scopes.push({ label: t.scopeSelection(cells.cells.length), target: cells });
			scopes.push({ label: t.scopeCell, target: { kind: 'cell', cells: [[context.path, context.prop]] } });
			const paths = selection?.paths ?? [context.path];
			const props = selection?.props ?? [context.prop];
			scopes.push({ label: paths.length > 1 ? t.scopeRows(paths.length) : t.scopeRow, target: { kind: 'row', paths } });
			scopes.push({ label: props.length > 1 ? t.scopeColumns(props.length) : t.scopeColumn, target: { kind: 'column', props } });
		}
		openFormatPanel({ host: context.host, viewName: context.viewName, root: context.root, scopes, path: context.path, prop: context.prop }, at);
	}

	/** Open the format window for the selected cells, or the cell with the focus (command palette). */
	formatSelection(host: TableHost): void {
		const t = strings();
		const table = host.table();
		if (!table?.viewName) {
			new Notice(t.formatNoTable);
			return;
		}
		const { selection } = table;
		const path = selection?.paths[0] ?? table.active?.path;
		const prop = selection?.props[0] ?? table.active?.prop;
		if (!path || !prop) {
			new Notice(t.formatNoCell);
			return;
		}
		const cell = table.rows.find((row) => row.file.path === path)?.cells.find((each) => each.prop === prop);
		const rect = (cell?.drawn ? cell.el : table.containerEl).getBoundingClientRect();
		this.openFormat({ host, viewName: table.viewName, root: host.root, table, prop, path, selection }, { x: rect.left, y: rect.bottom + 4 });
	}

	// ---- column widths -----------------------------------------------------------------------

	private isThumbnailColumn(info: BaseInfo | null, viewName: string, prop: string): boolean {
		return Boolean(info?.formula && prop === `formula.${info.formula}` && info.views.find((view) => view.name === viewName)?.thumbnails);
	}

	private textWidth(text: string, font: string): number {
		this.canvas ??= createEl('canvas');
		const context = this.canvas.getContext('2d');
		if (!context) return text.length * 8;
		context.font = font;
		return context.measureText(text).width;
	}

	private longestLine(text: string, font: string): number {
		return Math.max(0, ...text.split('\n').map((line) => this.textWidth(line, font)));
	}

	/** Lines a text needs at a width, from the widths of its own lines. */
	private static lines(lineWidths: number[], width: number): number {
		if (width <= 0) return Infinity;
		return lineWidths.reduce((sum, line) => sum + Math.max(1, Math.ceil(line / width)), 0);
	}

	/** The width a drawn header or body cell needs to show its content on one line. */
	private naturalWidth(td: HTMLElement): number {
		const content = td.find('.bases-table-header') ?? td.find('.bases-table-cell');
		if (!content) return 0;
		// Obsidian's own measuring state: every part of the cell takes its full width. Text cells
		// would still stretch to the column's width; for this moment they do not.
		td.addClasses(['is-measuring', MEASURE_WIDTH]);
		const style = getComputedStyle(td);
		const width = content.offsetWidth + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
		td.removeClasses(['is-measuring', MEASURE_WIDTH]);
		return Math.ceil(width) + 2;
	}

	/** True when a drawn body cell shows all of its content at this width, within its row. */
	private fitsAt(td: HTMLElement, width: number): boolean {
		const content = td.find('.bases-table-cell');
		if (!content) return true;
		const before = td.style.width;
		td.setCssStyles({ width: `${width}px` });
		const fits = content.scrollHeight <= content.clientHeight + 1 && content.scrollWidth <= content.clientWidth + 1;
		td.setCssStyles({ width: before });
		return fits;
	}

	private metricsOf(table: NativeTable): TextMetrics {
		const sample = table.rows.flatMap((row) => row.cells).find((cell) => cell.drawn && !holdsImage(cell.el) && cell.el.textContent?.trim());
		const content = sample?.el.find('.bases-table-cell') ?? sample?.el ?? table.containerEl;
		const style = getComputedStyle(content);
		const size = parseFloat(style.fontSize) || 14;
		const lineHeight = parseFloat(style.lineHeight);
		let padding = 20;
		if (sample) {
			const text = this.longestLine(sample.el.textContent?.trim() ?? '', style.font);
			const natural = this.naturalWidth(sample.el);
			if (natural > text) padding = Math.min(60, Math.max(8, natural - text));
		}
		return { font: style.font, padding, lineHeight: Number.isFinite(lineHeight) ? lineHeight : size * 1.5 };
	}

	/**
	 * The width a column needs: the header and every value on one line. In a table of taller rows,
	 * where text wraps, a column of long text gets the narrowest width at which every value fits
	 * its row instead. Never wider than the table on screen. The plugin's thumbnail column follows
	 * its row height and thumbnail shape.
	 */
	private fitWidth(table: NativeTable, prop: string, info: BaseInfo | null, metrics: TextMetrics): number {
		const viewName = table.viewName ?? '';
		if (this.isThumbnailColumn(info, viewName, prop)) return tableColumnWidth(table.rowHeight, info?.aspects[viewName] ?? 1);
		const header = table.header.find((cell) => cell.prop === prop)?.el;
		// No header cell at all: its name, plus room for its icon.
		const headerWidth = header ? measure(table.headerEl, header, () => this.naturalWidth(header))
			: this.textWidth(table.displayName(prop), metrics.font) + metrics.padding + 28;
		const cells = table.rows.flatMap((row) => row.cells.filter((cell) => cell.prop === prop && !holdsImage(cell.el)).map((cell) => ({ row: row.el, el: cell.el })));
		// Rows scrolled out of sight: from their text.
		const paths = new Set(table.rows.map((row) => row.file.path));
		const others = table.entries().filter((entry) => !paths.has(entry.path)).slice(0, ESTIMATE_LIMIT)
			.map((entry) => entry.text(prop))
			.filter((text) => text.trim() !== '' && !looksLikeImage(text))
			.map((text) => text.split('\n').map((line) => this.textWidth(line, metrics.font)));
		const widest = Math.max(
			MIN_COLUMN_WIDTH, headerWidth,
			...cells.map((cell) => measure(cell.row, cell.el, () => this.naturalWidth(cell.el))),
			...others.map((lines) => Math.max(...lines) + metrics.padding),
		);
		const oneLine = Math.min(Math.max(MIN_COLUMN_WIDTH, table.visibleWidth - 24), Math.ceil(widest));
		// Short content stays on one line, also in taller rows.
		if (!table.containerEl.hasClass('mod-multiline') || oneLine <= Math.min(360, table.visibleWidth * 0.4)) return oneLine;
		// Long text wraps in taller rows: the narrowest width at which nothing is cut off.
		const rowHeight = table.rows[0]?.el.offsetHeight ?? 0;
		if (rowHeight <= 0) return oneLine;
		const room = Math.floor((rowHeight - 6) / metrics.lineHeight);
		const fits = (width: number) => cells.every((cell) => measure(cell.row, cell.el, () => this.fitsAt(cell.el, width)))
			&& others.every((lines) => TableCells.lines(lines, width - metrics.padding) <= room);
		return narrowestFit(Math.min(oneLine, Math.max(MIN_COLUMN_WIDTH, headerWidth)), oneLine, fits);
	}

	/** Fit columns of a table view to their content: the given ones, or (null) all of them. */
	async fitColumns(host: TableHost, props: string[] | null): Promise<void> {
		const table = host.table();
		if (!table?.viewName) return;
		const info = host.info();
		const metrics = this.metricsOf(table);
		const widths: Record<string, number> = {};
		let thumbnails = false;
		for (const prop of props ?? table.properties) {
			if (this.isThumbnailColumn(info, table.viewName, prop)) thumbnails = true;
			else widths[prop] = this.fitWidth(table, prop, info, metrics);
		}
		await host.setColumnWidths(table.viewName, widths, thumbnails);
	}

	private resetWidth(context: CellContext): void {
		// Obsidian's own reset also clears the width it holds in memory; the settings alone would not.
		if (!context.table.resetWidth(context.prop)) void context.host.setColumnWidths(context.viewName, { [context.prop]: null }, false);
	}

	// ---- row height --------------------------------------------------------------------------

	/** The row height the content needs: drawn cells as they wrap, the other cells from their text. */
	private neededRowHeight(table: NativeTable, info: BaseInfo | null, metrics: TextMetrics, current: number): number {
		const container = table.containerEl;
		const multiline = container.hasClass('mod-multiline');
		const images = new Set<string>();
		let needed = 0;
		// For one moment every cell is as tall as its content, wrapped as in taller rows.
		container.addClasses(['mod-multiline', MEASURE_HEIGHT]);
		try {
			for (const row of table.rows) {
				for (const cell of row.cells) {
					if (holdsImage(cell.el)) {
						// An image grows with its row: keep the rows as tall as they are.
						images.add(cell.prop);
						needed = Math.max(needed, current);
					} else {
						needed = Math.max(needed, measure(row.el, cell.el, () => cell.el.offsetHeight));
					}
				}
			}
		} finally {
			container.removeClass(MEASURE_HEIGHT);
			if (!multiline) container.removeClass('mod-multiline');
		}
		// Rows scrolled out of sight: from their text.
		const drawn = new Set(table.rows.flatMap((row) => row.cells.map((cell) => `${row.file.path}\n${cell.prop}`)));
		const viewName = table.viewName ?? '';
		const columns = table.properties
			.filter((prop) => !images.has(prop) && !this.isThumbnailColumn(info, viewName, prop))
			.map((prop): [string, number] => [prop, Math.max(40, table.columnWidth(prop) - metrics.padding)]);
		for (const entry of table.entries().slice(0, ESTIMATE_LIMIT)) {
			for (const [prop, width] of columns) {
				if (drawn.has(`${entry.path}\n${prop}`)) continue;
				const text = entry.text(prop);
				if (!text.trim() || looksLikeImage(text)) continue;
				const lines = TableCells.lines(text.split('\n').map((line) => this.textWidth(line, metrics.font)), width);
				needed = Math.max(needed, lines * metrics.lineHeight + 8);
			}
		}
		return needed;
	}

	/** Set the row height of a table view to the lowest of Obsidian's heights that shows all of its content. */
	async fitRows(host: TableHost): Promise<void> {
		const table = host.table();
		if (!table?.viewName) return;
		const t = strings();
		const unit = rowUnit(table.containerEl);
		const current = rowPreset(table.rowHeight);
		const needed = this.neededRowHeight(table, host.info(), this.metricsOf(table), rowPixels(current, unit));
		const preset = fitRowPreset(needed, unit);
		const label = `${rowLabel(preset)} · ${rowPixels(preset, unit)}px`;
		if (preset === current) {
			new Notice(t.rowsAlready(label));
			return;
		}
		await host.setRowHeight(table.viewName, preset);
		new Notice(t.rowsFitted(label));
	}

	// ---- double-click and the line under a row -----------------------------------------------

	/**
	 * Double-click on the line between two column headers fits the column. Obsidian's own
	 * double-click (back to its automatic width) runs when the column already fits, so it stays
	 * one more double-click away. Double-click on the line under a row fits the rows.
	 */
	onDoubleClick(event: MouseEvent, root: HTMLElement): void {
		if (event.button !== 0 || !(event.target instanceof Element)) return;
		if (this.rowEdgeAt(event, root)) {
			const host = this.hostOf(root);
			if (!host) return;
			event.preventDefault();
			event.stopPropagation();
			void this.fitRows(host);
			return;
		}
		const td = event.target.closest('.bases-table-header-resizer')?.closest<HTMLElement>('.bases-td');
		if (!td || !root.contains(td)) return;
		const context = this.contextAt(root, td);
		if (!context) return;
		const info = context.host.info();
		const width = this.fitWidth(context.table, context.prop, info, this.metricsOf(context.table));
		const saved = context.table.customWidth(context.prop);
		if (saved > 0 && Math.abs(saved - width) <= 2) return;
		event.preventDefault();
		event.stopPropagation();
		const thumbnails = this.isThumbnailColumn(info, context.viewName, context.prop);
		void context.host.setColumnWidths(context.viewName, thumbnails ? {} : { [context.prop]: width }, thumbnails);
	}

	/** The row whose bottom line is under the pointer, or null. */
	private rowEdgeAt(event: MouseEvent, root: HTMLElement): HTMLElement | null {
		if (Platform.isMobile || !(event.target instanceof Element)) return null;
		const row = event.target.closest<HTMLElement>('.bases-tbody .bases-tr');
		if (!row || !root.contains(row) || row.closest('.is-selecting') || row.find('.bases-td:focus-within')) return null;
		const below = row.getBoundingClientRect().bottom - event.clientY;
		return below >= -1 && below <= EDGE_SIZE ? row : null;
	}

	onPointerMove(event: PointerEvent, root: HTMLElement): void {
		if (this.dragging || event.buttons !== 0) return;
		const near = this.rowEdgeAt(event, root) !== null;
		if (near !== root.hasClass(EDGE)) root.toggleClass(EDGE, near);
	}

	onPointerLeave(root: HTMLElement): void {
		if (!this.dragging) root.removeClass(EDGE);
	}

	/** A press on the line under a row starts a row height drag instead of a selection. */
	onPointerDown(event: PointerEvent, root: HTMLElement): void {
		if (event.button === 2) this.notePress(event, root);
		if (event.button !== 0) return;
		const row = this.rowEdgeAt(event, root);
		if (!row) return;
		const host = this.hostOf(root);
		const table = host?.table();
		if (!host || !table?.viewName) return;
		event.preventDefault();
		event.stopPropagation();
		this.swallowClick = true;
		this.dragRows(event, root, host, table.viewName, table, row);
	}

	onClick(event: MouseEvent): void {
		if (!this.swallowClick) return;
		this.swallowClick = false;
		event.preventDefault();
		event.stopPropagation();
	}

	/** Drag the line under a row: the rows snap to Obsidian's heights, saved once on release. */
	private dragRows(event: PointerEvent, root: HTMLElement, host: TableHost, viewName: string, table: NativeTable, row: HTMLElement): void {
		const unit = rowUnit(table.containerEl);
		const current = rowPreset(table.rowHeight);
		const top = row.getBoundingClientRect().top;
		const area = table.containerEl.getBoundingClientRect();
		const startY = event.clientY;
		const win = root.win;
		let preset = current;
		let moved = false;
		this.dragging = true;
		const stop = new AbortController();
		const finish = (save: boolean) => {
			stop.abort();
			this.guide?.detach();
			this.guide = null;
			this.dragging = false;
			root.removeClass(EDGE);
			// The click that ends the press comes right after; let later clicks through.
			win.setTimeout(() => {
				this.swallowClick = false;
			}, 0);
			if (save && moved && preset !== current) void host.setRowHeight(viewName, preset);
		};
		win.addEventListener('pointermove', (move) => {
			if (!moved && Math.abs(move.clientY - startY) < 3) return;
			moved = true;
			preset = nearestRowPreset(rowPixels(current, unit) + move.clientY - startY, unit);
			const px = rowPixels(preset, unit);
			this.guide ??= root.doc.body.createDiv({ cls: GUIDE });
			this.guide.setCssStyles({ top: `${top + px}px`, left: `${area.left}px`, width: `${area.width}px` });
			this.guide.setAttr('data-label', `${rowLabel(preset)} · ${px}px`);
		}, { signal: stop.signal });
		win.addEventListener('pointerup', () => finish(true), { signal: stop.signal });
		win.addEventListener('pointercancel', () => finish(false), { signal: stop.signal });
		win.addEventListener('keydown', (key) => {
			if (key.key !== 'Escape') return;
			key.stopPropagation();
			finish(false);
		}, { signal: stop.signal, capture: true });
	}
}
