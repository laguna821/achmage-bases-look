import { Platform } from 'obsidian';
import { drawnScale } from './pan';
import { contentWidthOf, viewScrollerOf } from './native';

/** On an embed made wider than the note's text. */
const WIDE = 'achmage-look-wide';
/** The thin scrollbar that follows the bottom of the screen, and its content. */
const BAR = 'achmage-look-hscroll';
const BAR_INNER = 'achmage-look-hscroll-inner';
/** On an embed that shows that scrollbar, and on the view it scrolls (whose own bar is hidden then). */
const BAR_ON = 'achmage-look-hscroll-on';
const BAR_SOURCE = 'achmage-look-hscroll-source';
/** On the view while there is more to see on that side. */
const FADE_LEFT = 'achmage-look-fade-left';
const FADE_RIGHT = 'achmage-look-fade-right';
/** Room kept free at the edges of the note. */
const EDGE = 12;

interface NoteBox {
	/** The note's scroll area. */
	page: HTMLElement;
	/** The text column (readable line length) the embed sits in. */
	column: HTMLElement;
}

/**
 * Where an embed stays as wide as the text: a hover preview, a canvas, a phone (where Obsidian
 * already shows embeds edge to edge), and blocks that scroll or indent on their own.
 */
const KEEP_NARROW = '.hover-popover, .canvas-node, .callout-content, .markdown-embed-content, li, blockquote, td, th';

/** The note around an embed: reading view or live preview. Null where it stays narrow. */
function noteAround(el: HTMLElement): NoteBox | null {
	if (Platform.isPhone || el.parentElement?.closest(KEEP_NARROW)) return null;
	const reading = el.closest<HTMLElement>('.markdown-preview-view');
	if (reading) {
		const column = el.closest<HTMLElement>('.markdown-preview-sizer');
		return column ? { page: reading, column } : null;
	}
	const page = el.closest<HTMLElement>('.cm-scroller');
	const column = el.closest<HTMLElement>('.cm-content');
	return page && column ? { page, column } : null;
}

/** The content box of an element on screen: left edge and width. */
function contentBox(el: HTMLElement): { left: number; width: number } {
	const rect = el.getBoundingClientRect();
	const style = getComputedStyle(el);
	const padLeft = parseFloat(style.paddingLeft) || 0;
	const padRight = parseFloat(style.paddingRight) || 0;
	const scale = drawnScale(el);
	return { left: rect.left + el.clientLeft * scale + padLeft * scale, width: (el.clientWidth - padLeft - padRight) * scale };
}

/** The element that takes the embed's width and margin: the editor's widget in live preview. */
function frameOf(el: HTMLElement): HTMLElement {
	const widget = el.closest<HTMLElement>('.cm-embed-block');
	return widget && widget.contains(el) && widget.closest('.cm-content') ? widget : el;
}

/**
 * The layout of a base embedded in a note: as wide as its table (or kanban) needs, up to the
 * width of the note, with a thin sideways scrollbar that follows the bottom of the screen and a
 * soft edge on the side where there is more to see. Changes the page only, never a file.
 */
export class EmbedLayout {
	/** The bar each view scrolls with, and the signal its listeners stop with. */
	private readonly bars = new WeakMap<HTMLElement, HTMLElement>();
	private readonly bound = new WeakMap<HTMLElement, AbortSignal>();
	/** How far each widened embed is moved to the left of where the note puts it. */
	private readonly shifts = new WeakMap<HTMLElement, number>();
	/** Views whose bar and view are being brought together: the echo of that is ignored. */
	private readonly syncing = new WeakSet<HTMLElement>();

	update(el: HTMLElement, owner: unknown, wide: boolean, signal: AbortSignal): void {
		const scroller = viewScrollerOf(owner);
		if (!scroller || !el.contains(scroller)) {
			this.clear(el);
			return;
		}
		this.widen(el, scroller, wide);
		this.bar(el, scroller, signal);
		this.fade(scroller);
	}

	clear(el: HTMLElement): void {
		this.narrow(el);
		el.findAll(`:scope > .${BAR}`).forEach((bar) => bar.detach());
		el.removeClass(BAR_ON);
		el.findAll(`.${BAR_SOURCE}`).forEach((view) => view.removeClass(BAR_SOURCE));
		el.findAll(`.${FADE_LEFT}, .${FADE_RIGHT}`).forEach((view) => view.removeClasses([FADE_LEFT, FADE_RIGHT]));
	}

	private widen(el: HTMLElement, scroller: HTMLElement, wide: boolean): void {
		const note = wide ? noteAround(el) : null;
		if (!note) {
			this.narrow(el);
			return;
		}
		const frame = frameOf(el);
		const column = contentBox(note.column);
		const page = contentBox(note.page);
		const scale = drawnScale(scroller);
		// What the content needs on screen: its own width, the view's frame, and the embed around it.
		const own = contentWidthOf(scroller);
		if (own === null) {
			this.narrow(el);
			return;
		}
		const content = (own + scroller.offsetWidth - scroller.clientWidth) * scale;
		const around = Math.max(0, el.getBoundingClientRect().width - scroller.getBoundingClientRect().width);
		const room = page.width - EDGE * 2;
		const width = Math.min(room, Math.max(column.width, Math.ceil(content + around)));
		if (width <= column.width + 4) {
			this.narrow(el);
			return;
		}
		// Centered on the text, kept inside the note. Moved as Obsidian moves embeds on a phone
		// (a transform, so the text around it keeps its place and the note never scrolls sideways).
		const pageLeft = page.left + EDGE;
		const left = Math.min(Math.max(column.left + (column.width - width) / 2, pageLeft), pageLeft + room - width);
		const placed = frame.getBoundingClientRect().left - (this.shifts.get(frame) ?? 0);
		const offset = Math.round(left - placed);
		const size = `${Math.round(width)}px`;
		const shift = offset === 0 ? '' : `translateX(${offset}px)`;
		if (frame.style.width !== size || frame.style.transform !== shift) {
			frame.setCssStyles({ width: size, maxWidth: 'none', transform: shift });
		}
		this.shifts.set(frame, offset);
		if (frame !== el && el.style.width !== '100%') el.setCssStyles({ width: '100%', maxWidth: 'none' });
		el.addClass(WIDE);
	}

	private narrow(el: HTMLElement): void {
		if (!el.hasClass(WIDE)) return;
		el.removeClass(WIDE);
		for (const target of new Set([el, frameOf(el)])) {
			target.setCssStyles({ width: '', maxWidth: '', transform: '' });
			this.shifts.delete(target);
		}
	}

	private bar(el: HTMLElement, scroller: HTMLElement, signal: AbortSignal): void {
		const overflow = scroller.scrollWidth > scroller.clientWidth + 2;
		let bar = el.find(`:scope > .${BAR}`);
		if (!overflow) {
			bar?.detach();
			el.removeClass(BAR_ON);
			scroller.removeClass(BAR_SOURCE);
			return;
		}
		if (!bar) {
			bar = el.createDiv({ cls: BAR, attr: { 'aria-hidden': 'true' } });
			bar.createDiv({ cls: BAR_INNER });
		}
		this.bars.set(scroller, bar);
		this.bind(bar, scroller, signal);
		const scale = drawnScale(scroller);
		const view = scroller.getBoundingClientRect();
		const box = el.getBoundingClientRect();
		bar.setCssStyles({ marginLeft: `${Math.round(view.left - box.left)}px`, width: `${Math.round(view.width)}px` });
		bar.find(`.${BAR_INNER}`)?.setCssStyles({ width: `${Math.round(scroller.scrollWidth * scale)}px` });
		const wanted = scroller.scrollLeft * scale;
		if (Math.abs(bar.scrollLeft - wanted) > 1) bar.scrollLeft = wanted;
		el.addClass(BAR_ON);
		scroller.addClass(BAR_SOURCE);
	}

	/** Move one of a view and its bar to match the other, once; the scroll it causes is not echoed. */
	private sync(scroller: HTMLElement, run: () => void): void {
		if (this.syncing.has(scroller)) return;
		this.syncing.add(scroller);
		run();
		scroller.win.requestAnimationFrame(() => this.syncing.delete(scroller));
	}

	/** The bar and the view scroll together; each is bound once per set of listeners. */
	private bind(bar: HTMLElement, scroller: HTMLElement, signal: AbortSignal): void {
		if (signal.aborted) return;
		if (this.bound.get(bar) !== signal) {
			this.bound.set(bar, signal);
			bar.addEventListener('scroll', () => this.sync(scroller, () => {
				scroller.scrollLeft = bar.scrollLeft / drawnScale(scroller);
			}), { signal, passive: true });
		}
		if (this.bound.get(scroller) !== signal) {
			this.bound.set(scroller, signal);
			scroller.addEventListener('scroll', () => {
				this.fade(scroller);
				const current = this.bars.get(scroller);
				if (current?.isConnected) {
					this.sync(scroller, () => {
						current.scrollLeft = scroller.scrollLeft * drawnScale(scroller);
					});
				}
			}, { signal, passive: true });
		}
	}

	private fade(scroller: HTMLElement): void {
		const max = scroller.scrollWidth - scroller.clientWidth;
		scroller.toggleClass(FADE_LEFT, max > 2 && scroller.scrollLeft > 1);
		scroller.toggleClass(FADE_RIGHT, max > 2 && scroller.scrollLeft < max - 1);
	}
}
