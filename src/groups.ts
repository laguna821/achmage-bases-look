// Group colors, stored in the `.base` file itself so they travel with the base:
//
//   achmageLook:
//     groupColors:
//       보고 싶음: "#0090FF"
//
// Obsidian keeps keys it does not know when it saves a base, so this survives normal editing.
// Pure functions only, so the tests can run them in Node.

type Rec = Record<string, unknown>;

export const STORE_KEY = 'achmageLook';

/** Readable in light and dark themes, distinct from each other. */
export const PALETTE = ['#0090FF', '#30A46C', '#F76B15', '#8E4EC6', '#E5484D', '#12A594', '#FFB224', '#D6409F'];

function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `#RRGGBB` in upper case, or null for anything else. Accepts `RRGGBB` and `#rgb`. */
export function normalizeHex(input: string): string | null {
	const value = input.trim().replace(/^#/, '');
	if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toUpperCase()}`;
	if (/^[0-9a-f]{3}$/i.test(value)) return `#${value.split('').map((c) => c + c).join('').toUpperCase()}`;
	return null;
}

export function readGroupColors(base: Rec): Record<string, string> {
	const store = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : null;
	const colors = store && isRecord(store.groupColors) ? store.groupColors : null;
	const result: Record<string, string> = {};
	if (!colors) return result;
	for (const [group, value] of Object.entries(colors)) {
		const hex = typeof value === 'string' ? normalizeHex(value) : null;
		if (hex) result[group] = hex;
	}
	return result;
}

/** Set or clear (null) colors for groups. Removes the store entirely when nothing is left. */
export function writeGroupColors(base: Rec, changes: Record<string, string | null>): Rec {
	const store: Rec = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : {};
	const colors: Rec = isRecord(store.groupColors) ? store.groupColors : {};
	for (const [group, value] of Object.entries(changes)) {
		const hex = value === null ? null : normalizeHex(value);
		if (hex) colors[group] = hex;
		else delete colors[group];
	}
	if (Object.keys(colors).length > 0) store.groupColors = colors;
	else delete store.groupColors;
	if (Object.keys(store).length > 0) base[STORE_KEY] = store;
	else delete base[STORE_KEY];
	return base;
}

/** Colors for the groups that have none yet, taking palette colors that are not in use first. */
export function autoColors(groups: string[], existing: Record<string, string>): Record<string, string> {
	const used = new Set(Object.values(existing));
	const free = PALETTE.filter((color) => !used.has(color));
	const queue = free.length > 0 ? free : [...PALETTE];
	const result: Record<string, string> = {};
	let i = 0;
	for (const group of groups) {
		if (existing[group]) continue;
		result[group] = queue[i % queue.length] ?? '#0090FF';
		i++;
	}
	return result;
}

export interface GroupStyle {
	background: boolean;
	/** Background shade strength in percent. */
	tint: number;
	border: boolean;
	heading: boolean;
}

/** Per-base overrides of the group look. Missing fields fall back to the plugin settings. */
export function readGroupStyle(base: Rec): Partial<GroupStyle> {
	const store = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : null;
	const style = store && isRecord(store.groupStyle) ? store.groupStyle : null;
	const result: Partial<GroupStyle> = {};
	if (!style) return result;
	if (typeof style.background === 'boolean') result.background = style.background;
	if (typeof style.border === 'boolean') result.border = style.border;
	if (typeof style.heading === 'boolean') result.heading = style.heading;
	if (typeof style.tint === 'number' && Number.isFinite(style.tint)) result.tint = Math.min(40, Math.max(2, Math.round(style.tint)));
	return result;
}

export function writeGroupStyle(base: Rec, changes: Partial<GroupStyle>): Rec {
	const store: Rec = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : {};
	const style: Rec = isRecord(store.groupStyle) ? store.groupStyle : {};
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete style[key];
		else style[key] = value;
	}
	if (Object.keys(style).length > 0) store.groupStyle = style;
	else delete store.groupStyle;
	if (Object.keys(store).length > 0) base[STORE_KEY] = store;
	else delete base[STORE_KEY];
	return base;
}
