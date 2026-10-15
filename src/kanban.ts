// Pure helpers for kanban views without a group property. No Obsidian imports, so the tests can
// run them in Node.
//
// A kanban view needs `groupBy`: without it Bases shows only “Choose a property”. With it, even a
// property no note has yet, every card shows at once in the group without a value (“None”).

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Status-like property names, most preferred first. */
export const STATUS_PROPERTIES = ['상태', 'status', 'Status', 'state', 'State', '단계', 'stage', 'Stage', '진행'];

export interface KanbanViewState {
	name: string;
	type: string;
	/** Group-by property as stored in the file, or null. */
	groupBy: string | null;
}

/**
 * Kanban views that should be grouped: kanban views without a group property that are new to
 * kanban, so that opening an existing base never changes it.
 * - In a base file created while the plugin runs (`isNewFile`), every such view.
 * - Otherwise only a view that was added, or became a kanban, since the file was last read.
 *   A kanban that had a group property a moment ago lost it on purpose and stays as it is.
 */
export function kanbanViewsNeedingGroup(views: KanbanViewState[], previous: KanbanViewState[] | null, isNewFile = false): string[] {
	const candidates = views.filter((view) => view.type === 'kanban' && !view.groupBy && view.name);
	if (!previous) return isNewFile ? candidates.map((view) => view.name) : [];
	return candidates
		.filter((view) => {
			const old = previous.find((each) => each.name === view.name);
			return !old || old.type !== 'kanban';
		})
		.map((view) => view.name);
}

/** The status-like property most notes have a text value for, or the fallback when none has. */
export function pickGroupProperty(frontmatters: (Rec | null | undefined)[], fallback: string): string {
	let best: string | null = null;
	let bestCount = 0;
	for (const name of STATUS_PROPERTIES) {
		const count = frontmatters.filter((frontmatter) => {
			const value = frontmatter?.[name];
			return typeof value === 'string' && value.trim() !== '';
		}).length;
		if (count > bestCount) {
			best = name;
			bestCount = count;
		}
	}
	return best ?? fallback;
}

/** Group one view by a note property. Returns false when the view is missing or already grouped. */
export function setViewGroupBy(base: Rec, viewName: string, property: string): boolean {
	const views = Array.isArray(base.views) ? base.views.filter(isRecord) : [];
	const view = views.find((each) => each.name === viewName);
	if (!view || isRecord(view.groupBy)) return false;
	view.groupBy = { property, direction: 'ASC' };
	return true;
}
