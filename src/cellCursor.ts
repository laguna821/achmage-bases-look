import { Scope, type App } from 'obsidian';
import { activeCellOf, cellPlaceOf, editActiveCell, samePlace, tableContainerOf } from './native';
import { pageScrollerOf } from './pan';
import { movesCell, pressSelects } from './tableNav.ts';

/** On a table whose cells a press selects (the cell pointer shows over them). */
const SELECTING = 'achmage-look-cell-select';
/** Under the pointer, these keep doing what they do: links open, a checkbox ticks, buttons work. */
const CONTROL = 'a, .internal-link, .external-link, .tag, input[type="checkbox"], button, [role="button"], .clickable-icon';
/** An element a cell is edited in. */
const FIELD = 'input, textarea, select, [contenteditable="true"]';
/** A click this long after the press that selected a cell is no longer that press's click. */
const CLICK_MS = 1000;

interface TableState {
	/** What holds the table's controller: a Bases leaf's view, or an embed's `{ controller }`. */
	owner: unknown;
	/** What the table is drawn in: a leaf's view container, or an embed element. */
	root: HTMLElement;
	/** A press selects the cell instead of editing it. */
	selects: boolean;
	/** The note around the table scrolls along with the selected cell (a base embedded in a note). */
	follow: boolean;
	stop: AbortController;
}

/** Where a point is in a text, for browsers that tell (all that Obsidian runs in do). */
interface CaretSource {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
}

/**
 * Tables that move like a spreadsheet. Bases already moves the selected cell with the arrow keys,
 * Tab, Home, End and the page keys, edits it with Enter and comes back to it with Escape, but only
 * while the table itself holds the keyboard focus, and a press always starts editing its cell.
 * Here a press selects the cell and gives the table the focus; a second press, Enter, F2 or a
 * double-click edits. In a note, the note scrolls along with the selected cell.
 */
export class CellCursor {
	private readonly app: App;
	private readonly tables = new Map<HTMLElement, TableState>();
	/** The press that selects its cell, once Bases has seen it. */
	private press: PointerEvent | null = null;
	/** The table the click of that press comes to, and until when. */
	private swallow: { container: HTMLElement; until: number } | null = null;
	/**
	 * While a table holds the keyboard focus, F2 edits its selected cell. Obsidian handles its
	 * hotkeys before any view sees the key, and its own F2 renames the note: a scope of the
	 * table's own goes first for that one key, and every other key goes on to Obsidian as before.
	 */
	private readonly scope: Scope;
	private focused: HTMLElement | null = null;
	private pushed = false;

	constructor(app: App) {
		this.app = app;
		this.scope = new Scope(app.scope);
		this.scope.register([], 'F2', (event) => {
			const state = this.focused ? this.tables.get(this.focused) : undefined;
			if (state && !event.isComposing) editActiveCell(state.owner);
			// Never the note's rename while a cell is selected, even one that cannot be edited.
			return false;
		});
	}

	/** Keep the table of a view in step with the view's setting (on every paint of the view). */
	update(owner: unknown, root: HTMLElement, selects: boolean, follow: boolean): void {
		this.prune();
		const container = tableContainerOf(owner);
		if (!container || !root.contains(container)) return;
		let state = this.tables.get(container);
		if (!state) {
			state = { owner, root, selects, follow, stop: new AbortController() };
			this.tables.set(container, state);
			this.listen(container, state.stop.signal);
		}
		state.owner = owner;
		state.root = root;
		state.selects = selects;
		state.follow = follow;
		if (container.hasClass(SELECTING) !== selects) container.toggleClass(SELECTING, selects);
	}

	/**
	 * A press inside a leaf's view or an embed, seen before Bases sees it (the root's own capture):
	 * decided now, while Bases still holds the cell that was selected before the press.
	 */
	beforePress(event: PointerEvent, root: HTMLElement): void {
		this.press = null;
		this.swallow = null;
		if (event.defaultPrevented || !(event.target instanceof Element)) return;
		const td = event.target.closest<HTMLElement>('.bases-tbody .bases-td');
		const container = td?.closest<HTMLElement>('.bases-table-container') ?? null;
		const state = container ? this.tables.get(container) : undefined;
		if (!td || !container || !state?.selects || !root.contains(container)) return;
		const pressed = cellPlaceOf(state.owner, td);
		if (!pressed) return;
		const active = activeCellOf(state.owner);
		const focused = container.doc.activeElement;
		const field = focused?.closest(FIELD) ?? null;
		const selects = pressSelects({
			button: event.button,
			primary: event.isPrimary,
			pointerType: event.pointerType,
			ctrl: event.ctrlKey,
			meta: event.metaKey,
			alt: event.altKey,
			shift: event.shiftKey,
			onControl: event.target.closest(CONTROL) !== null,
			editing: field !== null && td.contains(field),
			tableFocused: focused === container,
			onSelected: active !== null && samePlace(active, pressed),
		});
		if (selects) this.press = event;
	}

	/** Forget the tables drawn in a root (it shows another layout, or the plugin stops there). */
	clear(root: HTMLElement): void {
		for (const [container, state] of this.tables) {
			if (state.root === root || root.contains(container)) this.forget(container, state);
		}
	}

	destroy(): void {
		for (const [container, state] of this.tables) this.forget(container, state);
		this.press = null;
		this.swallow = null;
	}

	private forget(container: HTMLElement, state: TableState): void {
		state.stop.abort();
		this.leave(container);
		container.removeClass(SELECTING);
		this.tables.delete(container);
	}

	/** A table got the keyboard focus (its cells are moved through): F2 is the table's now. */
	private enter(container: HTMLElement): void {
		this.focused = container;
		if (this.pushed) return;
		this.app.keymap.pushScope(this.scope);
		this.pushed = true;
	}

	/** The focus left the table (into a cell's editor, the note, another pane …). */
	private leave(container: HTMLElement): void {
		if (this.focused !== container) return;
		this.focused = null;
		if (!this.pushed) return;
		this.app.keymap.popScope(this.scope);
		this.pushed = false;
	}

	/** Tables no longer on screen (another view shown, a note closed) lose their listeners. */
	private prune(): void {
		for (const [container, state] of this.tables) {
			if (!container.isConnected) this.forget(container, state);
		}
	}

	/** Listeners on the table itself, after Bases' own (which it added when it drew the table). */
	private listen(container: HTMLElement, signal: AbortSignal): void {
		// Bases has selected the pressed cell by now. Keep the browser from starting to edit it,
		// and give the table the keyboard focus, so that the arrow keys move through the cells.
		container.addEventListener('pointerdown', (event) => {
			if (this.press !== event) return;
			this.press = null;
			event.preventDefault();
			this.swallow = { container, until: event.timeStamp + CLICK_MS };
			container.focus({ preventScroll: true });
		}, { signal, capture: true });
		// Bases opens a cell's editor on the click that ends a press; not after a press that selected.
		container.addEventListener('click', (event) => {
			const swallow = this.swallow;
			if (swallow?.container !== container) return;
			this.swallow = null;
			if (event.timeStamp <= swallow.until) event.preventDefault();
		}, { signal, capture: true });
		// A double-click edits with the cursor where it was clicked, as in a spreadsheet, instead of
		// selecting the word there (which the next key typed would replace).
		container.addEventListener('dblclick', (event) => {
			const field = event.target instanceof Element ? event.target.closest<HTMLElement>('[contenteditable="true"]') : null;
			if (!field || !container.contains(field) || field.doc.activeElement !== field) return;
			const source: CaretSource = field.doc;
			const caret = source.caretPositionFromPoint?.(event.clientX, event.clientY);
			const selection = field.win.getSelection();
			if (!caret || !selection || !field.contains(caret.offsetNode)) return;
			selection.collapse(caret.offsetNode, caret.offset);
		}, { signal });
		container.addEventListener('keydown', (event) => this.onKey(event, container), { signal });
		// Only the table itself, not a cell's editor inside it (focus and blur do not bubble).
		container.addEventListener('focus', () => this.enter(container), { signal });
		container.addEventListener('blur', () => this.leave(container), { signal });
		if (container.doc.activeElement === container) this.enter(container);
	}

	private onKey(event: KeyboardEvent, container: HTMLElement): void {
		const state = this.tables.get(container);
		if (!state || event.isComposing) return;
		// Bases has moved the selected cell and scrolled the table to it; the note follows.
		if (state.follow && event.defaultPrevented && movesCell(event.key)) this.follow(container, state.root);
	}

	/** Scroll the note so that the selected cell is in sight, with a row of room around it. */
	private follow(container: HTMLElement, root: HTMLElement): void {
		container.win.requestAnimationFrame(() => {
			const cell = container.find('.bases-table-active-cell');
			const page = cell?.isConnected ? pageScrollerOf(root) : null;
			if (!cell || !page) return;
			const rect = cell.getBoundingClientRect();
			if (rect.height <= 0) return;
			const box = page.getBoundingClientRect();
			const room = Math.min(rect.height * 1.5, box.height / 4);
			if (rect.top < box.top + room) page.scrollTop -= box.top + room - rect.top;
			else if (rect.bottom > box.bottom - room) page.scrollTop += rect.bottom - (box.bottom - room);
		});
	}
}
