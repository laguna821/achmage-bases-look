// Moving through a view without hunting for scrollbars: a press on a table cell that selects the
// cell instead of editing it, as in a spreadsheet, and the left and right edges of an embedded
// view that move it sideways while the pointer rests there. Pure, so the tests can run it in Node.

/** How close to the left or right edge of a view the pointer moves it, in pixels on screen. */
export const EDGE_ZONE = 40;
/** How long the pointer rests at an edge before the view starts to move, in milliseconds. */
export const EDGE_DWELL = 250;
/** How long the view takes to reach full speed once it moves, in milliseconds. */
export const EDGE_RAMP = 300;
/** Speed at the inner side of an edge and at the very edge, in pixels per second on screen. */
export const EDGE_SLOW = 150;
export const EDGE_FAST = 1400;

export interface EdgeZone {
	/** -1 to the left, 1 to the right. */
	direction: -1 | 1;
	/** 0 at the inner side of the edge, 1 at the very edge. */
	depth: number;
}

/**
 * The edge of a view that a pointer at `x` rests on, when the view can still move that way.
 * `left` and `right` are the view's edges on screen, `scrolled` how far it is scrolled and `max`
 * how far it can scroll. A view too narrow to have a middle has no edges.
 */
export function edgeZone(x: number, left: number, right: number, scrolled: number, max: number, zone = EDGE_ZONE): EdgeZone | null {
	if (max <= 1 || right - left < zone * 3 || x < left || x > right) return null;
	if (x - left < zone && scrolled > 0.5) return { direction: -1, depth: Math.min(1, 1 - (x - left) / zone) };
	if (right - x < zone && scrolled < max - 0.5) return { direction: 1, depth: Math.min(1, 1 - (right - x) / zone) };
	return null;
}

/** Pixels per second for a pointer this deep in an edge: slow at its inner side, fast at the edge. */
export function edgeSpeed(depth: number): number {
	const d = Math.min(1, Math.max(0, depth));
	return EDGE_SLOW + (EDGE_FAST - EDGE_SLOW) * d * d;
}

/** The share of its speed a view moves at after moving this many milliseconds: a gentle start. */
export function edgeRamp(moving: number): number {
	return 0.2 + 0.8 * Math.min(1, Math.max(0, moving / EDGE_RAMP));
}

/** A press on a table cell, and what is around it. */
export interface CellPress {
	button: number;
	/** The pointer is the main one (not a second finger). */
	primary: boolean;
	pointerType: string;
	ctrl: boolean;
	meta: boolean;
	alt: boolean;
	shift: boolean;
	/** A link, a checkbox or a button is under the pointer: it keeps doing what it does. */
	onControl: boolean;
	/** The pressed cell is being edited already. */
	editing: boolean;
	/** The table itself holds the keyboard focus (its cells are being moved through) … */
	tableFocused: boolean;
	/** … and the pressed cell is the one selected. */
	onSelected: boolean;
}

/**
 * Whether a press on a table cell selects the cell instead of editing it, as in a spreadsheet: a
 * press selects, a second press on the selected cell edits it, Shift + press extends the
 * selection. Links, checkboxes, buttons, a cell being edited, touch, and presses with Ctrl, Cmd or
 * Alt keep Obsidian's behavior.
 */
export function pressSelects(press: CellPress): boolean {
	if (press.button !== 0 || !press.primary || press.pointerType === 'touch') return false;
	if (press.ctrl || press.meta || press.alt || press.onControl || press.editing) return false;
	return press.shift || !(press.tableFocused && press.onSelected);
}

/** Keys with which Bases moves the selected cell of a table. */
export function movesCell(key: string): boolean {
	return /^(Arrow(Up|Down|Left|Right)|Page(Up|Down)|Home|End|Tab)$/.test(key);
}
