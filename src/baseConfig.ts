// Pure transforms of a parsed `.base` file. No Obsidian imports, so the tests can run them in Node.
//
// Core Bases already knows how to draw thumbnails:
// - cards and kanban views take an `image` property id plus `imageFit` / `imageAspectRatio`,
// - table and list views render the result of the `image()` formula function.
// Turning thumbnails on therefore only means writing those settings for every view.

export type RatioPreset = 'square' | 'landscape' | 'wide' | 'portrait' | 'poster';
export type FitPreset = 'cover' | 'contain';

export interface BaseLook {
	/** One size scale for every view type, 0 (smallest) to 100 (largest). */
	size: number | null;
	ratio: RatioPreset | null;
	fit: FitPreset | null;
}

export const RATIOS: Record<RatioPreset, number> = {
	square: 1,
	landscape: 0.75,
	wide: 0.5625,
	portrait: 1.3333,
	poster: 1.5,
};

export const SIZE_PRESETS = { small: 15, medium: 45, large: 80 } as const;

const clampSize = (size: number) => Math.min(100, Math.max(0, Math.round(size)));

// Native defaults: cards `cardSize` 200, kanban `columnWidth` 280, table `rowHeight` "" (short).
export const cardSizeFor = (size: number) => Math.round(140 + clampSize(size) * 2.6);
export const columnWidthFor = (size: number) => Math.round(220 + clampSize(size) * 2.4);
export const rowHeightFor = (size: number) => (size < 34 ? 'medium' : size < 67 ? 'tall' : 'extra');
export const listPixelsFor = (size: number) => Math.round(24 + clampSize(size) * 0.96);
const ROW_HEIGHT_SIZES: Record<string, number> = { medium: SIZE_PRESETS.small, tall: SIZE_PRESETS.medium, extra: SIZE_PRESETS.large };

const COVER_VIEWS = new Set(['cards', 'kanban']);
const FORMULA_VIEWS = new Set(['table', 'list']);

type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function views(base: Rec): Rec[] {
	return Array.isArray(base.views) ? base.views.filter(isRecord) : [];
}

/** Property id as Bases stores it for a frontmatter property. */
export function propertyId(property: string): string {
	return `note.${property}`;
}

/** A property reference usable inside a formula. */
export function formulaReference(property: string): string {
	return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(property) ? `note.${property}` : `note[${JSON.stringify(property)}]`;
}

export function thumbnailFormula(property: string): string {
	return `image(${formulaReference(property)})`;
}

function sameProperty(value: unknown, property: string): boolean {
	return value === propertyId(property) || value === property;
}

/** Name of the formula that renders this property as an image, if the base has one. */
export function findThumbnailFormula(base: Rec, property: string): string | null {
	if (!isRecord(base.formulas)) return null;
	const wanted = thumbnailFormula(property).replace(/\s+/g, '');
	for (const [name, expr] of Object.entries(base.formulas)) {
		if (typeof expr === 'string' && expr.replace(/\s+/g, '') === wanted) return name;
	}
	return null;
}

function formulaNameFor(base: Rec, property: string): string {
	const existing = findThumbnailFormula(base, property);
	if (existing) return existing;
	const formulas = isRecord(base.formulas) ? base.formulas : {};
	let name = property;
	for (let i = 2; name in formulas; i++) name = `${property} ${i}`;
	return name;
}

/** True when at least one view of the base shows this property as a thumbnail. */
export function isEnabled(base: Rec, property: string): boolean {
	const formula = findThumbnailFormula(base, property);
	return views(base).some((view) => {
		if (COVER_VIEWS.has(String(view.type))) return sameProperty(view.image, property);
		if (FORMULA_VIEWS.has(String(view.type)) && formula) {
			return Array.isArray(view.order) && view.order.includes(`formula.${formula}`);
		}
		return false;
	});
}

export function enable(base: Rec, property: string, look: BaseLook): Rec {
	const formula = formulaNameFor(base, property);
	let usesFormula = false;
	for (const view of views(base)) {
		const type = String(view.type);
		if (COVER_VIEWS.has(type)) {
			view.image = propertyId(property);
		} else if (FORMULA_VIEWS.has(type)) {
			const current: unknown[] = Array.isArray(view.order) ? (view.order as unknown[]) : ['file.name'];
			const order = current.filter((item) => item !== `formula.${formula}`);
			view.order = [`formula.${formula}`, ...order];
			// The default short table row leaves room for a tiny icon only.
			if (type === 'table' && view.rowHeight === undefined) view.rowHeight = rowHeightFor(SIZE_PRESETS.medium);
			usesFormula = true;
		}
	}
	if (usesFormula) {
		const formulas = isRecord(base.formulas) ? base.formulas : {};
		formulas[formula] = thumbnailFormula(property);
		base.formulas = formulas;
	}
	applyLook(base, property, look);
	return base;
}

export function disable(base: Rec, property: string): Rec {
	const formula = findThumbnailFormula(base, property);
	for (const view of views(base)) {
		const type = String(view.type);
		if (COVER_VIEWS.has(type) && sameProperty(view.image, property)) {
			delete view.image;
		} else if (FORMULA_VIEWS.has(type) && formula && Array.isArray(view.order)) {
			view.order = view.order.filter((item) => item !== `formula.${formula}`);
		}
	}
	if (formula && isRecord(base.formulas)) {
		delete base.formulas[formula];
		if (Object.keys(base.formulas).length === 0) delete base.formulas;
	}
	return base;
}

/** Write the given size, shape and fit into every view that shows the thumbnails. Null fields are left alone. */
export function applyLook(base: Rec, property: string, look: Partial<BaseLook>): Rec {
	const formula = findThumbnailFormula(base, property);
	for (const view of views(base)) {
		const type = String(view.type);
		if (COVER_VIEWS.has(type) && sameProperty(view.image, property)) {
			if (look.ratio) view.imageAspectRatio = RATIOS[look.ratio];
			if (look.fit) {
				if (look.fit === 'contain') view.imageFit = 'contain';
				else delete view.imageFit;
			}
			if (typeof look.size === 'number') {
				if (type === 'cards') view.cardSize = cardSizeFor(look.size);
				else view.columnWidth = columnWidthFor(look.size);
			}
		} else if (type === 'table' && typeof look.size === 'number' && formula && Array.isArray(view.order) && view.order.includes(`formula.${formula}`)) {
			view.rowHeight = rowHeightFor(look.size);
		}
	}
	return base;
}

/** The preset whose value matches (within rounding), or null for a custom value. */
function matchPreset<K extends string>(table: Record<K, number>, value: unknown): K | null {
	if (typeof value !== 'number') return null;
	for (const [key, target] of Object.entries(table) as [K, number][]) {
		if (Math.abs(target - value) <= 0.001 * Math.max(1, target)) return key;
	}
	return null;
}

/** The look of the first thumbnail view, used to put check marks in the toolbar menu. */
export function readLook(base: Rec, property: string): BaseLook {
	const look: BaseLook = { size: null, ratio: null, fit: null };
	for (const view of views(base)) {
		const type = String(view.type);
		if (!COVER_VIEWS.has(type) || !sameProperty(view.image, property)) continue;
		look.ratio = matchPreset(RATIOS, view.imageAspectRatio);
		look.fit = view.imageFit === 'contain' ? 'contain' : 'cover';
		look.size = type === 'cards'
			? clampSize(((typeof view.cardSize === 'number' ? view.cardSize : 200) - 140) / 2.6)
			: clampSize(((typeof view.columnWidth === 'number' ? view.columnWidth : 280) - 220) / 2.4);
		return look;
	}
	for (const view of views(base)) {
		if (view.type === 'table' && typeof view.rowHeight === 'string' && view.rowHeight in ROW_HEIGHT_SIZES) {
			look.size = ROW_HEIGHT_SIZES[view.rowHeight] ?? null;
			break;
		}
	}
	return look;
}
