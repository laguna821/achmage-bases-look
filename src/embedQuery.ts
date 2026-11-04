// The settings of a base embedded in a note, as Bases holds them in memory. Kept apart from the
// DOM so it can be tested on its own. A Bases controller has a `query` with its views; each view
// keeps its own settings (column widths, row height, the plugin's `achmageLook` …) behind
// `get`/`set`, and `set` makes Bases show the change and save the base where it keeps it.

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
	return typeof value === 'object' && value !== null ? (value as Rec) : null;
}

/** Keys of a view that Bases keeps as fields of its own; every other key is a view setting. */
const VIEW_FIELDS = new Set(['type', 'name', 'filters', 'groupBy', 'groupOrder', 'order', 'sort', 'limit', 'summaries', 'query', 'data']);

interface EmbedQuery {
	views: unknown[];
	toString(): string;
	getViewConfig(name: string): unknown;
	save(): void;
}

interface EmbedViewConfig {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	getAll?: () => unknown;
}

/** The query of a Bases controller, when it has the shape this version knows. */
export function queryOf(controller: unknown): (Rec & EmbedQuery) | null {
	const query = rec(rec(controller)?.query);
	if (!query || !Array.isArray(query.views) || typeof query.getViewConfig !== 'function' || typeof query.save !== 'function') return null;
	return query as Rec & EmbedQuery;
}

function viewConfigOf(query: EmbedQuery, name: string): (Rec & EmbedViewConfig) | null {
	const config = rec(query.getViewConfig(name));
	return config && typeof config.get === 'function' && typeof config.set === 'function' ? (config as Rec & EmbedViewConfig) : null;
}

/** Layout and name of the view an embedded base shows now (its toolbar can switch views). */
export function embedShownView(controller: unknown): { type: string | null; name: string | null } {
	const value = rec(controller);
	const type = rec(value?.view)?.type;
	const name = value?.viewName;
	return { type: typeof type === 'string' ? type : null, name: typeof name === 'string' && name ? name : null };
}

/** A setting of one view of an embedded base, as Bases holds it now (saved or not). */
export function embedViewSetting(controller: unknown, viewName: string, key: string): unknown {
	const query = queryOf(controller);
	const config = query ? viewConfigOf(query, viewName) : null;
	return config?.get(key);
}

/** The embedded base as text, with the changes Bases has not saved yet. Null when unreadable. */
export function embedQueryText(controller: unknown): string | null {
	const query = queryOf(controller);
	if (!query) return null;
	try {
		const text = query.toString();
		return typeof text === 'string' && !text.startsWith('[object') ? text : null;
	} catch {
		return null;
	}
}

/** Equal as values read from YAML: objects key by key (in any order), lists item by item. */
export function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
	}
	const x = rec(a);
	const y = rec(b);
	if (!x || !y) return false;
	const keys = Object.keys(x);
	return keys.length === Object.keys(y).length && keys.every((key) => Object.hasOwn(y, key) && sameValue(x[key], y[key]));
}

/**
 * Give an embedded base the settings of `edited`: the base as `embedQueryText` read it, then
 * changed. Only view settings (column widths, row height, the plugin's own key …) and the base's
 * own `achmageLook` are taken over, each through Bases, which shows them at once and saves them
 * where the embed keeps its base: the base file, or the code block in the note. Settings that did
 * not change are not touched. Returns false, changing nothing, when the edited base does not
 * match the embed's views.
 */
export function editEmbedQuery(controller: unknown, edited: Record<string, unknown>): boolean {
	const query = queryOf(controller);
	if (!query) return false;
	const editedViews = Array.isArray(edited.views) ? edited.views.map(rec) : [];
	const names = query.views.map((view) => rec(view)?.name);
	if (editedViews.length !== names.length || editedViews.some((view, i) => !view || view.name !== names[i]) || new Set(names).size !== names.length) return false;
	const configs = names.map((name) => (typeof name === 'string' ? viewConfigOf(query, name) : null));
	if (configs.some((config) => !config)) return false;
	editedViews.forEach((view, i) => {
		const config = configs[i];
		if (!view || !config) return;
		const stored = rec(config.getAll?.()) ?? {};
		for (const key of new Set([...Object.keys(view), ...Object.keys(stored)])) {
			if (VIEW_FIELDS.has(key)) continue;
			const next = view[key] ?? null;
			if (!sameValue(config.get(key) ?? null, next)) config.set(key, next);
		}
	});
	const data = rec(query.unrecognizedData);
	const store = edited.achmageLook;
	if (data && !sameValue(data.achmageLook ?? null, store ?? null)) {
		if (store === undefined || store === null) delete data.achmageLook;
		else data.achmageLook = store;
		query.save();
	}
	return true;
}
