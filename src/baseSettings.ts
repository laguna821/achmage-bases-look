// Settings of one base file: what the base says for itself (under `achmageLook:`), what it
// already uses, and only then the plugin's defaults. Pure, so the tests can run it in Node.

type Rec = Record<string, unknown>;

const STORE_KEY = 'achmageLook';
const COVER_VIEWS = new Set(['cards', 'kanban']);

function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function views(base: Rec): Rec[] {
	return Array.isArray(base.views) ? base.views.filter(isRecord) : [];
}

/** The plugin settings that act as defaults for every base. */
export interface BaseDefaults {
	property: string;
	linkProperty: string;
	folder: string;
	autoKanbanGroup: boolean;
	listSize: number;
}

/** What a base stores for itself. A missing value follows the defaults. */
export interface StoredBaseSettings {
	thumbnailProperty?: string;
	linkProperty?: string;
	imageFolder?: string;
	autoKanbanGroup?: boolean;
	listSize?: number;
}

export interface BaseSettings {
	/** Note property the base shows as thumbnails. */
	thumbnailProperty: string;
	/** Set in this base, found in its views, or the plugin default. */
	thumbnailSource: 'base' | 'detected' | 'default';
	/** A card or kanban view shows images from a file or formula property, which stays as it is. */
	external: boolean;
	linkProperty: string;
	imageFolder: string;
	autoKanbanGroup: boolean;
	listSize: number;
	stored: StoredBaseSettings;
}

export function readStoredSettings(base: Rec): StoredBaseSettings {
	const store = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : {};
	const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
	const stored: StoredBaseSettings = {};
	const thumbnailProperty = text(store.thumbnailProperty);
	if (thumbnailProperty) stored.thumbnailProperty = thumbnailProperty;
	// An empty link property is a choice too: no link for this base.
	if (typeof store.linkProperty === 'string') stored.linkProperty = store.linkProperty.trim();
	const imageFolder = text(store.imageFolder);
	if (imageFolder) stored.imageFolder = imageFolder;
	if (typeof store.autoKanbanGroup === 'boolean') stored.autoKanbanGroup = store.autoKanbanGroup;
	if (typeof store.listSize === 'number' && Number.isFinite(store.listSize)) stored.listSize = Math.min(100, Math.max(0, store.listSize));
	return stored;
}

/** What a card or kanban `image` value shows: a note property, or a file or formula property. */
function imageSource(value: unknown): { note: string } | { external: true } | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const id = value.trim();
	if (id.startsWith('note.')) return id.length > 'note.'.length ? { note: id.slice('note.'.length) } : null;
	if (id.startsWith('file.') || id.startsWith('formula.')) return { external: true };
	return { note: id };
}

/** Note property inside an `image(note.X)` or `image(note["X"])` formula. */
export function formulaImageProperty(expression: unknown): string | null {
	if (typeof expression !== 'string') return null;
	const match = /^\s*image\(\s*note(?:\.([\p{L}\p{N}_]+)|\[\s*"([^"]+)"\s*\])\s*\)\s*$/u.exec(expression);
	return match?.[1] ?? match?.[2] ?? null;
}

/**
 * The note property a base already shows as images: the first card or kanban `image`, else an
 * image() formula shown in a table or list. `external` tells that some view shows images from
 * a file or formula property.
 */
export function detectThumbnailProperty(base: Rec): { property: string | null; external: boolean } {
	let property: string | null = null;
	let external = false;
	for (const view of views(base)) {
		if (!COVER_VIEWS.has(String(view.type))) continue;
		const found = imageSource(view.image);
		if (found && 'external' in found) external = true;
		else if (found && !property) property = found.note;
	}
	if (!property && isRecord(base.formulas)) {
		const shown = new Set(views(base).flatMap((view) => (Array.isArray(view.order) ? (view.order as unknown[]) : [])));
		for (const [name, expression] of Object.entries(base.formulas)) {
			const found = formulaImageProperty(expression);
			if (found && shown.has(`formula.${name}`)) {
				property = found;
				break;
			}
		}
	}
	return { property, external };
}

export function resolveBaseSettings(base: Rec, defaults: BaseDefaults): BaseSettings {
	const stored = readStoredSettings(base);
	const detected = detectThumbnailProperty(base);
	const thumbnailProperty = stored.thumbnailProperty ?? detected.property ?? defaults.property;
	return {
		thumbnailProperty,
		thumbnailSource: stored.thumbnailProperty ? 'base' : detected.property ? 'detected' : 'default',
		external: detected.external,
		linkProperty: stored.linkProperty ?? defaults.linkProperty,
		imageFolder: stored.imageFolder ?? defaults.folder,
		autoKanbanGroup: stored.autoKanbanGroup ?? defaults.autoKanbanGroup,
		listSize: stored.listSize ?? defaults.listSize,
		stored,
	};
}

/** Store (or, with null, clear) settings of this base. Other `achmageLook:` values stay. */
export function writeStoredSettings(base: Rec, changes: { [K in keyof StoredBaseSettings]?: StoredBaseSettings[K] | null }): Rec {
	const store: Rec = isRecord(base[STORE_KEY]) ? base[STORE_KEY] : {};
	for (const [key, value] of Object.entries(changes)) {
		if (value === null || value === undefined) delete store[key];
		else store[key] = typeof value === 'string' ? value.trim() : value;
	}
	if (Object.keys(store).length > 0) base[STORE_KEY] = store;
	else delete base[STORE_KEY];
	return base;
}
