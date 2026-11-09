import { drawnScale } from './pan';
import { edgeRamp, edgeSpeed, edgeZone, EDGE_DWELL, type EdgeZone } from './tableNav.ts';

/** While the pointer is on these, a view stays where it is (a column is being resized). */
const STILL = '.bases-table-header-resizer';
const FIELD = 'input, textarea, select, [contenteditable="true"]';
/** After the wheel, a pointer at an edge waits until it moves again (it did not go there). */
const AFTER_WHEEL_MS = 400;
/** Longest step between two frames, so that a busy moment does not make the view jump. */
const MAX_FRAME_MS = 50;

interface Glide {
	x: number;
	y: number;
	direction: -1 | 1;
	/** When the pointer came to the edge. */
	since: number;
	last: number;
	/** The part of a pixel still to move. */
	carry: number;
	frame: number;
}

/** The edge of a view under a point, while the view can move that way and nothing in it is edited. */
function zoneAt(view: HTMLElement, x: number, y: number): EdgeZone | null {
	const active = view.doc.activeElement;
	if (active && view.contains(active) && active.matches(FIELD)) return null;
	const rect = view.getBoundingClientRect();
	if (y < rect.top || y > rect.bottom) return null;
	return edgeZone(x, rect.left, rect.right, view.scrollLeft, view.scrollWidth - view.clientWidth);
}

/**
 * A base embedded in a note moves sideways while the mouse rests at its left or right edge, where
 * the view fades out because there is more to see: slowly at first and faster nearer the edge. No
 * buttons: moving the mouse away, pressing, the wheel or a key stops it at once.
 */
export class EdgeScroll {
	/** Listen on an embed. `viewOf` gives the element that scrolls its view sideways, or null when off. */
	attach(el: HTMLElement, viewOf: () => HTMLElement | null, signal: AbortSignal): void {
		const win = el.win;
		let glide: Glide | null = null;
		let quietUntil = 0;
		const stop = () => {
			if (glide) win.cancelAnimationFrame(glide.frame);
			glide = null;
		};
		const tick = (now: number) => {
			if (!glide) return;
			const view = viewOf();
			// Still under the pointer: not covered by a preview or a menu that came up over it.
			const zone = view && el.matches(':hover') ? zoneAt(view, glide.x, glide.y) : null;
			if (!view || zone?.direction !== glide.direction) {
				stop();
				return;
			}
			const elapsed = Math.min(MAX_FRAME_MS, Math.max(0, now - glide.last));
			glide.last = now;
			const moving = now - glide.since - EDGE_DWELL;
			if (moving >= 0) {
				// Speed on screen, moved in the view's own pixels (a zoomed view moves more of them).
				glide.carry += (zone.direction * edgeSpeed(zone.depth) * edgeRamp(moving) * elapsed) / 1000 / drawnScale(view);
				const whole = Math.trunc(glide.carry);
				if (whole !== 0) {
					const before = view.scrollLeft;
					view.scrollLeft = before + whole;
					glide.carry -= whole;
					if (view.scrollLeft === before) {
						stop();
						return;
					}
				}
			}
			glide.frame = win.requestAnimationFrame(tick);
		};
		el.addEventListener('pointermove', (event) => {
			if (event.pointerType !== 'mouse' || event.buttons !== 0) {
				stop();
				return;
			}
			// A mouse that really moved: the note scrolling under a still pointer does not count.
			if ((event.movementX === 0 && event.movementY === 0) || event.timeStamp < quietUntil) return;
			const view = viewOf();
			const still = event.target instanceof Element && event.target.closest(STILL) !== null;
			const zone = view && !still ? zoneAt(view, event.clientX, event.clientY) : null;
			if (!zone) {
				stop();
				return;
			}
			if (glide?.direction === zone.direction) {
				glide.x = event.clientX;
				glide.y = event.clientY;
				return;
			}
			stop();
			const now = win.performance.now();
			glide = { x: event.clientX, y: event.clientY, direction: zone.direction, since: now, last: now, carry: 0, frame: win.requestAnimationFrame(tick) };
		}, { signal, passive: true });
		el.addEventListener('pointerleave', stop, { signal });
		el.addEventListener('pointerdown', stop, { signal, capture: true });
		el.addEventListener('wheel', (event) => {
			stop();
			quietUntil = event.timeStamp + AFTER_WHEEL_MS;
		}, { signal, passive: true, capture: true });
		el.addEventListener('keydown', stop, { signal, capture: true });
		win.addEventListener('blur', stop, { signal });
		signal.addEventListener('abort', stop);
	}
}
