// Table format of one view: colors and text style for header cells, columns, rows and single
// cells, kept inside that view in the base file (`views[i].achmageLook.format`). Colors are
// stored per theme: a color set for the light theme shows only in the light theme. Obsidian
// ignores these keys, so without the plugin a base looks as it always did. Pure, so the tests
// can run it in Node.

import { normalizeHex } from './groups.ts';

type Rec = Record<string, unknown>;

const STORE_KEY = 'achmageLook';
const FORMAT_KEY = 'format';
const SECTIONS = ['header', 'columns', 'rows', 'cells'] as const;

/** A color that hides the color a column gives a row, or a row gives a cell. */
export const NO_COLOR = 'none';

export type Theme = 'light' | 'dark';
export type Align = 'left' | 'center' | 'right';
export const THEMES: readonly Theme[] = ['light', 'dark'];
export const ALIGNS: readonly Align[] = ['left', 'center', 'right'];

export interface ThemeColors {
	/** `#RRGGBB`, or `none`. */
	text?: string;
	fill?: string;
}

/** Format of one header cell, column, row or cell. What is not set comes from the layer under it. */
export interface CellFormat {
	light?: ThemeColors;
	dark?: ThemeColors;
	bold?: boolean;
	italic?: boolean;
	align?: Align;
}

export interface TableFormat {
	/** Header cells, by property id. */
	header: Record<string, CellFormat>;
	/** Every cell of a column, by property id. */
	columns: Record<string, CellFormat>;
	/** Every cell of a note's row, by note path. */
	rows: Record<string, CellFormat>;
	/** Single cells, by note path, then property id. */
	cells: Record<string, Record<string, CellFormat>>;
}

/** Where a format goes. A body cell shows its column's format, then its row's, then its own. */
export type FormatTarget =
	| { kind: 'header'; props: string[] }
	| { kind: 'column'; props: string[] }
	| { kind: 'row'; paths: string[] }
	| { kind: 'cell'; cells: [string, string][] };

export type FormatLayer = FormatTarget['kind'];

/**
 * A change. Colors belong to one theme: `#RRGGBB`, `none`, or null to clear. Bold, italic and
 * alignment are shared by both themes; null clears. Fields left out stay as they are.
 */
export interface FormatChange {
	theme?: Theme;
	text?: string | null;
	fill?: string | null;
	bold?: boolean | null;
	italic?: boolean | null;
	align?: Align | null;
}

/** What one cell shows in one theme. */
export interface ShownFormat {
	text: string | null;
	fill: string | null;
	bold: boolean;
	italic: boolean;
	align: Align | null;
}

function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function views(base: Rec): Rec[] {
	return Array.isArray(base.views) ? base.views.filter(isRecord) : [];
}

function findView(base: Rec, name: string): Rec | null {
	return views(base).find((view) => view.name === name) ?? null;
}

function readColor(value: unknown): string | undefined {
	if (value === NO_COLOR) return NO_COLOR;
	return typeof value === 'string' ? normalizeHex(value) ?? undefined : undefined;
}

function readColors(source: unknown): ThemeColors | undefined {
	if (!isRecord(source)) return undefined;
	const colors: ThemeColors = {};
	const text = readColor(source.text);
	const fill = readColor(source.fill);
	if (text) colors.text = text;
	if (fill) colors.fill = fill;
	return text || fill ? colors : undefined;
}

/** A stored format with only the values this version understands, or null when none is left. */
export function readCellFormat(source: unknown): CellFormat | null {
	if (!isRecord(source)) return null;
	const format: CellFormat = {};
	for (const theme of THEMES) {
		const colors = readColors(source[theme]);
		if (colors) format[theme] = colors;
	}
	if (typeof source.bold === 'boolean') format.bold = source.bold;
	if (typeof source.italic === 'boolean') format.italic = source.italic;
	if (typeof source.align === 'string' && (ALIGNS as readonly string[]).includes(source.align)) format.align = source.align as Align;
	return Object.keys(format).length > 0 ? format : null;
}

function readSection(source: unknown): Record<string, CellFormat> {
	const result: Record<string, CellFormat> = {};
	if (!isRecord(source)) return result;
	for (const [key, value] of Object.entries(source)) {
		const format = readCellFormat(value);
		if (format) result[key] = format;
	}
	return result;
}

export function emptyFormat(): TableFormat {
	return { header: {}, columns: {}, rows: {}, cells: {} };
}

/** The table format a view stores. Values this version does not understand are skipped. */
export function readTableFormat(base: Rec, viewName: string): TableFormat {
	return readLookFormat(findView(base, viewName)?.[STORE_KEY]);
}

/**
 * The table format inside a view's `achmageLook` value: what a base file stores, or what an
 * embedded base holds in memory.
 */
export function readLookFormat(look: unknown): TableFormat {
	const stored = isRecord(look) ? look[FORMAT_KEY] : undefined;
	const format = emptyFormat();
	if (!isRecord(stored)) return format;
	format.header = readSection(stored.header);
	format.columns = readSection(stored.columns);
	format.rows = readSection(stored.rows);
	if (isRecord(stored.cells)) {
		for (const [path, props] of Object.entries(stored.cells)) {
			const section = readSection(props);
			if (Object.keys(section).length > 0) format.cells[path] = section;
		}
	}
	return format;
}

/** How many header cells, columns, rows and single cells have a format. */
export function formatCounts(format: TableFormat): { header: number; columns: number; rows: number; cells: number } {
	return {
		header: Object.keys(format.header).length,
		columns: Object.keys(format.columns).length,
		rows: Object.keys(format.rows).length,
		cells: Object.values(format.cells).reduce((sum, props) => sum + Object.keys(props).length, 0),
	};
}

export function isEmptyFormat(format: TableFormat): boolean {
	const counts = formatCounts(format);
	return counts.header + counts.columns + counts.rows + counts.cells === 0;
}

function blank(): ShownFormat {
	return { text: null, fill: null, bold: false, italic: false, align: null };
}

/** Lay one stored format over what is shown so far. */
function cover(shown: ShownFormat, format: CellFormat | undefined, theme: Theme): ShownFormat {
	if (!format) return shown;
	const colors = format[theme];
	if (colors?.text) shown.text = colors.text === NO_COLOR ? null : colors.text;
	if (colors?.fill) shown.fill = colors.fill === NO_COLOR ? null : colors.fill;
	if (format.bold !== undefined) shown.bold = format.bold;
	if (format.italic !== undefined) shown.italic = format.italic;
	if (format.align) shown.align = format.align;
	return shown;
}

export function shownHeader(format: TableFormat, prop: string, theme: Theme): ShownFormat {
	return cover(blank(), format.header[prop], theme);
}

/** What a body cell shows: its column's format, then its row's, then its own. */
export function shownCell(format: TableFormat, path: string, prop: string, theme: Theme): ShownFormat {
	const shown = cover(blank(), format.columns[prop], theme);
	cover(shown, format.rows[path], theme);
	return cover(shown, format.cells[path]?.[prop], theme);
}

/** What a cell shows from the layers under one layer: what is left when that layer is cleared. */
export function shownUnder(format: TableFormat, layer: FormatLayer, path: string | null, prop: string, theme: Theme): ShownFormat {
	const shown = blank();
	if (layer === 'row' || layer === 'cell') cover(shown, format.columns[prop], theme);
	if (layer === 'cell' && path !== null) cover(shown, format.rows[path], theme);
	return shown;
}

/** The format one layer stores for a cell (the header layer for a header cell). */
export function layerFormat(format: TableFormat, layer: FormatLayer, path: string | null, prop: string): CellFormat | undefined {
	switch (layer) {
		case 'header':
			return format.header[prop];
		case 'column':
			return format.columns[prop];
		case 'row':
			return path === null ? undefined : format.rows[path];
		case 'cell':
			return path === null ? undefined : format.cells[path]?.[prop];
	}
}

/**
 * Turn a choice made in the format window into the change to store. A choice that matches what
 * the layers under the target already show is stored as a clear, so the file keeps only what
 * differs; “no color” over a colored column or row is stored as `none`. `path` and `prop` name
 * the cell the window was opened on.
 */
export function planChange(format: TableFormat, layer: FormatLayer, path: string | null, prop: string, theme: Theme, choice: FormatChange): FormatChange {
	const under = shownUnder(format, layer, path, prop, theme);
	const change: FormatChange = {};
	for (const key of ['text', 'fill'] as const) {
		const value = choice[key];
		if (value === undefined) continue;
		change.theme = theme;
		change[key] = value === null ? (under[key] ? NO_COLOR : null) : value;
	}
	for (const key of ['bold', 'italic'] as const) {
		const value = choice[key];
		if (value === undefined) continue;
		change[key] = value === null || value === under[key] ? null : value;
	}
	if (choice.align !== undefined) change.align = choice.align === under.align ? null : choice.align;
	return change;
}

/** The record under `key`, made when missing. */
function child(parent: Rec, key: string): Rec {
	const value = parent[key];
	if (isRecord(value)) return value;
	const made: Rec = {};
	parent[key] = made;
	return made;
}

/** Drop the record under `key` when it is empty. */
function prune(parent: Rec, key: string): void {
	const value = parent[key];
	if (isRecord(value) && Object.keys(value).length === 0) delete parent[key];
}

/** Where the formats of a target are kept: the record that holds each one, and its key there. */
function slots(stored: Rec, target: FormatTarget): [Rec, string][] {
	switch (target.kind) {
		case 'header':
			return target.props.map((prop): [Rec, string] => [child(stored, 'header'), prop]);
		case 'column':
			return target.props.map((prop): [Rec, string] => [child(stored, 'columns'), prop]);
		case 'row':
			return target.paths.map((path): [Rec, string] => [child(stored, 'rows'), path]);
		case 'cell':
			return target.cells.map(([path, prop]): [Rec, string] => [child(child(stored, 'cells'), path), prop]);
	}
}

/** Change one stored format in place. Keys this version does not know stay. */
function applyChange(entry: Rec, change: FormatChange): void {
	if (change.theme && (change.text !== undefined || change.fill !== undefined)) {
		const colors = child(entry, change.theme);
		for (const key of ['text', 'fill'] as const) {
			const value = change[key];
			if (value === undefined) continue;
			const color = value === null ? null : readColor(value);
			if (color) colors[key] = color;
			else delete colors[key];
		}
		prune(entry, change.theme);
	}
	for (const key of ['bold', 'italic'] as const) {
		const value = change[key];
		if (value === undefined) continue;
		if (typeof value === 'boolean') entry[key] = value;
		else delete entry[key];
	}
	if (change.align !== undefined) {
		if (change.align && ALIGNS.includes(change.align)) entry.align = change.align;
		else delete entry.align;
	}
}

/** Put the format back into the view, dropping whatever became empty. */
function store(view: Rec, look: Rec, stored: Rec): void {
	if (isRecord(stored.cells)) for (const path of Object.keys(stored.cells)) prune(stored.cells, path);
	for (const section of SECTIONS) prune(stored, section);
	if (Object.keys(stored).length > 0) look[FORMAT_KEY] = stored;
	else delete look[FORMAT_KEY];
	if (Object.keys(look).length > 0) view[STORE_KEY] = look;
	else delete view[STORE_KEY];
}

/**
 * Format a target in one view. Only that view's `achmageLook.format` changes; empty entries are
 * removed again. Returns false when the base has no view of that name.
 */
export function writeTableFormat(base: Rec, viewName: string, target: FormatTarget, change: FormatChange): boolean {
	const view = findView(base, viewName);
	if (!view) return false;
	const look: Rec = isRecord(view[STORE_KEY]) ? view[STORE_KEY] : {};
	const stored: Rec = isRecord(look[FORMAT_KEY]) ? look[FORMAT_KEY] : {};
	for (const [holder, key] of slots(stored, target)) {
		const entry: Rec = isRecord(holder[key]) ? holder[key] : {};
		applyChange(entry, change);
		if (Object.keys(entry).length > 0) holder[key] = entry;
		else delete holder[key];
	}
	store(view, look, stored);
	return true;
}

/** True when the target itself stores a format (not counting the layers under it). */
export function hasFormat(format: TableFormat, target: FormatTarget): boolean {
	switch (target.kind) {
		case 'header':
			return target.props.some((prop) => prop in format.header);
		case 'column':
			return target.props.some((prop) => prop in format.columns);
		case 'row':
			return target.paths.some((path) => path in format.rows);
		case 'cell':
			return target.cells.some(([path, prop]) => format.cells[path]?.[prop] !== undefined);
	}
}

/** Clear the format of a target, or with null every format of the view. */
export function clearTableFormat(base: Rec, viewName: string, target: FormatTarget | null): boolean {
	const view = findView(base, viewName);
	if (!view) return false;
	const look = view[STORE_KEY];
	if (!isRecord(look) || !isRecord(look[FORMAT_KEY])) return true;
	const stored: Rec = target === null ? {} : look[FORMAT_KEY];
	if (target !== null) for (const [holder, key] of slots(stored, target)) delete holder[key];
	store(view, look, stored);
	return true;
}

/**
 * Move row and cell formats along with notes that were renamed or moved. `rename` gives the new
 * path of an old one, or null. A renamed note's format replaces anything left at its new path.
 * Returns true when something moved.
 */
export function renameNotePaths(base: Rec, rename: (path: string) => string | null): boolean {
	let changed = false;
	for (const view of views(base)) {
		const look = view[STORE_KEY];
		const stored = isRecord(look) ? look[FORMAT_KEY] : null;
		if (!isRecord(stored)) continue;
		for (const section of ['rows', 'cells'] as const) {
			const map = stored[section];
			if (!isRecord(map)) continue;
			for (const path of Object.keys(map)) {
				const next = rename(path);
				if (next === null || next === path) continue;
				const moved = map[path];
				const there = map[next];
				delete map[path];
				map[next] = section === 'cells' && isRecord(there) && isRecord(moved) ? { ...there, ...moved } : moved;
				changed = true;
			}
		}
	}
	return changed;
}

// ---- Row heights and column widths ---------------------------------------------------------

export type RowPreset = '' | 'medium' | 'tall' | 'extra';

/** Obsidian's row heights, as multiples of a short row (`--bases-table-row-height`, 30px by default). */
export const ROW_PRESETS: readonly (readonly [RowPreset, number])[] = [['', 1], ['medium', 2], ['tall', 4], ['extra', 8]];

/** The row height a view stores, as one of Obsidian's presets ('' is short). */
export function rowPreset(value: unknown): RowPreset {
	return ROW_PRESETS.find(([preset]) => preset === value)?.[0] ?? '';
}

export function rowPixels(preset: RowPreset, unit: number): number {
	const factor = ROW_PRESETS.find(([each]) => each === preset)?.[1] ?? 1;
	return Math.round((unit > 0 ? unit : 30) * factor);
}

/** The lowest row height at least `needed` pixels tall; the tallest one when none is. */
export function fitRowPreset(needed: number, unit: number): RowPreset {
	for (const [preset] of ROW_PRESETS) if (rowPixels(preset, unit) >= needed - 0.5) return preset;
	return 'extra';
}

/** The row height closest to `height` pixels, for dragging the line under a row. */
export function nearestRowPreset(height: number, unit: number): RowPreset {
	let best: RowPreset = '';
	for (const [preset] of ROW_PRESETS) {
		if (Math.abs(rowPixels(preset, unit) - height) < Math.abs(rowPixels(best, unit) - height)) best = preset;
	}
	return best;
}

/** Bases draws no column narrower than this, whatever width is saved. */
export const MIN_COLUMN_WIDTH = 100;

/**
 * The narrowest width from `min` to `max` at which `fits` holds, to within `step` pixels. `fits`
 * must hold for every width above one where it holds. When even `max` does not fit: `max`.
 */
export function narrowestFit(min: number, max: number, fits: (width: number) => boolean, step = 4): number {
	const low = Math.round(min);
	const high = Math.round(Math.max(min, max));
	if (fits(low)) return low;
	if (!fits(high)) return high;
	let bad = low;
	let good = high;
	while (good - bad > step) {
		const middle = Math.round((bad + good) / 2);
		if (fits(middle)) good = middle;
		else bad = middle;
	}
	return good;
}

// ---- Palette -------------------------------------------------------------------------------

export const PALETTE_NAMES = ['gray', 'brown', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'red'] as const;
export type PaletteName = (typeof PALETTE_NAMES)[number];

/**
 * Text and fill colors for each theme. Text colors stay readable on the theme's background and
 * fills keep the theme's own text readable (contrast 4.5:1 or more, checked by the tests).
 */
export const PALETTE: Record<Theme, Record<'text' | 'fill', Record<PaletteName, string>>> = {
	light: {
		text: { gray: '#5F6368', brown: '#8A5A3C', orange: '#B54708', yellow: '#8D6E00', green: '#1F7A3E', teal: '#0E7065', blue: '#1D5FB8', purple: '#6B3FB0', red: '#C0262D' },
		fill: { gray: '#EEEFF1', brown: '#F2E8E1', orange: '#FCE7D6', yellow: '#FBF1C7', green: '#E1F2E5', teal: '#D9F2EF', blue: '#DCEBFB', purple: '#ECE4F8', red: '#FBE1E1' },
	},
	dark: {
		text: { gray: '#B7BBC1', brown: '#D9B79E', orange: '#F5A86A', yellow: '#EBCB5B', green: '#7BD08F', teal: '#6FD3C6', blue: '#8DB9F5', purple: '#C2A6F2', red: '#F59C9C' },
		fill: { gray: '#2E3033', brown: '#3B2D24', orange: '#4A2D16', yellow: '#43391A', green: '#1E3A28', teal: '#173A37', blue: '#1B3354', purple: '#33264F', red: '#4A2226' },
	},
};
