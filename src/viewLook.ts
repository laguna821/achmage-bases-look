// The look of one view, stored inside that view in the base file (`views[i].achmageLook`).
// Obsidian keeps unknown keys of a view when it saves the base, so they follow the view through
// renames and copies. Pure, so the tests can run it in Node.

import type { FitPreset, RatioPreset } from './baseConfig.ts';
import type { GroupStyle } from './groups.ts';

type Rec = Record<string, unknown>;

const STORE_KEY = 'achmageLook';
const RATIO_NAMES = ['square', 'landscape', 'wide', 'portrait', 'poster'];

function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ViewLook {
	/** List thumbnail size, 0 (smallest) to 100. */
	listSize: number;
	/** Table and list thumbnail shape; null follows the base (its card views, or square). */
	shape: RatioPreset | null;
	/** Table and list thumbnail fit. */
	fit: FitPreset;
	/** Dashed frames on notes without a thumbnail. */
	placeholders: boolean;
	/** Same size and shape for the plugin's table and list thumbnails. */
	tidy: boolean;
	/** Cards lift under the mouse. */
	hoverLift: boolean;
	/** Table and list rows get a light highlight. */
	hoverRows: boolean;
	/** Highlight color; null uses the theme accent. */
	hoverColor: string | null;
	groupStyle: GroupStyle;
}

/** What a view stores for itself. A missing value follows the base, then the defaults. */
export type StoredViewLook = Partial<Omit<ViewLook, 'groupStyle'>> & { groupStyle?: Partial<GroupStyle> };

export type ViewLookChanges = { [K in Exclude<keyof ViewLook, 'groupStyle'>]?: ViewLook[K] | null } & { groupStyle?: Partial<GroupStyle> };

function findView(base: Rec, name: string): Rec | null {
	const views = Array.isArray(base.views) ? base.views.filter(isRecord) : [];
	return views.find((view) => view.name === name) ?? null;
}

function readLook(source: unknown): StoredViewLook {
	if (!isRecord(source)) return {};
	const look: StoredViewLook = {};
	if (typeof source.listSize === 'number' && Number.isFinite(source.listSize)) look.listSize = Math.min(100, Math.max(0, source.listSize));
	if (typeof source.shape === 'string' && RATIO_NAMES.includes(source.shape)) look.shape = source.shape as RatioPreset;
	if (source.fit === 'cover' || source.fit === 'contain') look.fit = source.fit;
	for (const key of ['placeholders', 'tidy', 'hoverLift', 'hoverRows'] as const) {
		if (typeof source[key] === 'boolean') look[key] = source[key];
	}
	if (typeof source.hoverColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.hoverColor)) look.hoverColor = source.hoverColor;
	if (isRecord(source.groupStyle)) {
		const style: Partial<GroupStyle> = {};
		for (const key of ['background', 'border', 'heading'] as const) {
			if (typeof source.groupStyle[key] === 'boolean') style[key] = source.groupStyle[key];
		}
		if (typeof source.groupStyle.tint === 'number') style.tint = source.groupStyle.tint;
		look.groupStyle = style;
	}
	return look;
}

/** The look a view stores for itself. */
export function readStoredViewLook(base: Rec, viewName: string): StoredViewLook {
	return readLook(findView(base, viewName)?.[STORE_KEY]);
}

/**
 * The look of a view: what the view stores, else what the whole base stored in earlier versions
 * (`achmageLook.listSize`, `thumbnailShape`, `thumbnailFit`, `groupStyle`), else the defaults.
 */
export function resolveViewLook(base: Rec, viewName: string, defaults: ViewLook): ViewLook {
	const own = readStoredViewLook(base, viewName);
	const store = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : {};
	const legacy = readLook({ listSize: store.listSize, shape: store.thumbnailShape, fit: store.thumbnailFit, groupStyle: store.groupStyle });
	return {
		listSize: own.listSize ?? legacy.listSize ?? defaults.listSize,
		shape: own.shape ?? legacy.shape ?? defaults.shape,
		fit: own.fit ?? legacy.fit ?? defaults.fit,
		placeholders: own.placeholders ?? defaults.placeholders,
		tidy: own.tidy ?? defaults.tidy,
		hoverLift: own.hoverLift ?? defaults.hoverLift,
		hoverRows: own.hoverRows ?? defaults.hoverRows,
		hoverColor: own.hoverColor !== undefined ? own.hoverColor : defaults.hoverColor,
		groupStyle: { ...defaults.groupStyle, ...legacy.groupStyle, ...own.groupStyle },
	};
}

/**
 * Store (or, with null, clear) look settings of one view only. Group look changes merge into
 * the view's group look. Returns false when the base has no view of that name.
 */
export function writeViewLook(base: Rec, viewName: string, changes: ViewLookChanges): boolean {
	const view = findView(base, viewName);
	if (!view) return false;
	const look: Rec = isRecord(view[STORE_KEY]) ? view[STORE_KEY] : {};
	for (const [key, value] of Object.entries(changes)) {
		if (key === 'groupStyle') {
			const style: Rec = isRecord(look.groupStyle) ? look.groupStyle : {};
			for (const [part, setting] of Object.entries(value as Rec)) {
				if (setting === null || setting === undefined) delete style[part];
				else style[part] = setting;
			}
			if (Object.keys(style).length > 0) look.groupStyle = style;
			else delete look.groupStyle;
		} else if (value === null || value === undefined) {
			delete look[key];
		} else {
			look[key] = value;
		}
	}
	if (Object.keys(look).length > 0) view[STORE_KEY] = look;
	else delete view[STORE_KEY];
	return true;
}
