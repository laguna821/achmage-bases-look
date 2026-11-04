import { viewScrollerOf, viewVerticalScrollerOf } from './native';

/** On the body while a view is dragged with the middle button. */
const PANNING = 'achmage-look-panning';
/** A middle click on these keeps doing what it does (a link opens in a new tab). */
const OWN_CLICK = 'a, .internal-link, .external-link, .tag, input, textarea, select, button';
/** The pointer has to move this far before the view moves. */
const START = 3;

/** How much smaller an element is drawn than its own size (a zoomed view). */
export function drawnScale(el: HTMLElement): number {
	const width = el.offsetWidth;
	const scale = width > 0 ? el.getBoundingClientRect().width / width : 1;
	return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The element that scrolls the page around an element up and down (a note around an embed). */
export function pageScrollerOf(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY;
		if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
	}
	return null;
}

/**
 * Press the middle button (the wheel) on a view and drag: the view moves with the hand, sideways
 * and up and down, as a map does. Returns true when a drag started.
 */
export function startPan(event: PointerEvent, root: HTMLElement, owner: unknown): boolean {
	if (event.button !== 1 || !(event.target instanceof Element) || event.target.closest(OWN_CLICK)) return false;
	const sideways = viewScrollerOf(owner);
	const upDown = viewVerticalScrollerOf(owner) ?? pageScrollerOf(root);
	if (!sideways && !upDown) return false;
	// No autoscroll or paste on the middle button here.
	event.preventDefault();
	const win = root.win;
	const doc = root.doc;
	const startX = event.clientX;
	const startY = event.clientY;
	const left = sideways?.scrollLeft ?? 0;
	const top = upDown?.scrollTop ?? 0;
	const scaleX = sideways ? drawnScale(sideways) : 1;
	const scaleY = upDown ? drawnScale(upDown) : 1;
	let moved = false;
	const stop = new AbortController();
	const finish = () => {
		stop.abort();
		doc.body.removeClass(PANNING);
		if (!moved) return;
		// The click that ends the drag must not open a link under the pointer.
		const swallow = (click: MouseEvent) => {
			click.preventDefault();
			click.stopPropagation();
		};
		win.addEventListener('auxclick', swallow, { capture: true, once: true });
		win.setTimeout(() => win.removeEventListener('auxclick', swallow, { capture: true }), 300);
	};
	win.addEventListener('pointermove', (move) => {
		const dx = move.clientX - startX;
		const dy = move.clientY - startY;
		if (!moved && Math.abs(dx) < START && Math.abs(dy) < START) return;
		if (!moved) {
			moved = true;
			doc.body.addClass(PANNING);
		}
		if (sideways) sideways.scrollLeft = left - dx / scaleX;
		if (upDown) upDown.scrollTop = top - dy / scaleY;
	}, { signal: stop.signal });
	win.addEventListener('pointerup', finish, { signal: stop.signal });
	win.addEventListener('pointercancel', finish, { signal: stop.signal });
	win.addEventListener('blur', finish, { signal: stop.signal });
	return true;
}
