/** A small window on the menu layer, such as the look panel and the format window. */
export interface Floating {
	el: HTMLElement;
	/** Keep the window inside the screen, after its content was drawn or changed. */
	place: () => void;
	close: () => void;
}

export interface FloatingOptions {
	doc: Document;
	cls: string;
	label: string;
	width: number;
	/** Under this element (it does not close the window when clicked), or at `point`. */
	anchor?: HTMLElement;
	point?: { x: number; y: number };
	/** `byKey` is true when Escape closed the window. */
	onClose?: (byKey: boolean) => void;
}

/**
 * Open a floating window. It never runs past the edge of the screen and scrolls inside
 * instead; a click outside it or Escape closes it.
 */
export function openFloating(options: FloatingOptions): Floating {
	const { doc, anchor } = options;
	const el = doc.body.createDiv({ cls: options.cls, attr: { role: 'dialog', 'aria-label': options.label } });

	const place = () => {
		const view = doc.documentElement;
		const width = Math.min(options.width, view.clientWidth - 16);
		if (anchor) {
			const rect = anchor.getBoundingClientRect();
			const top = rect.bottom + 6;
			const left = Math.max(8, Math.min(rect.left, view.clientWidth - width - 8));
			el.setCssStyles({ top: `${top}px`, left: `${left}px`, maxHeight: `${Math.max(240, view.clientHeight - top - 12)}px` });
			return;
		}
		const point = options.point ?? { x: 8, y: 8 };
		const left = Math.max(8, Math.min(point.x, view.clientWidth - width - 8));
		const top = Math.max(8, Math.min(point.y, view.clientHeight - el.offsetHeight - 8));
		el.setCssStyles({ top: `${top}px`, left: `${left}px`, maxHeight: `${view.clientHeight - 16}px` });
	};

	const onPointer = (event: PointerEvent) => {
		const target = event.target;
		if (target instanceof Node && (el.contains(target) || anchor?.contains(target))) return;
		// Native dropdown lists and suggestions render outside the window; keep it open for them.
		if (target instanceof Element && target.closest('.menu, .suggestion-container')) return;
		close(false);
	};
	const onKey = (event: KeyboardEvent) => {
		if (event.key !== 'Escape') return;
		// Escape first closes an open suggestion list, not the window.
		if (doc.querySelector('.suggestion-container')) return;
		event.stopPropagation();
		close(true);
	};
	doc.addEventListener('pointerdown', onPointer, true);
	doc.addEventListener('keydown', onKey, true);

	let closed = false;
	const close = (byKey: boolean) => {
		if (closed) return;
		closed = true;
		doc.removeEventListener('pointerdown', onPointer, true);
		doc.removeEventListener('keydown', onKey, true);
		el.detach();
		options.onClose?.(byKey);
	};
	return { el, place, close: () => close(false) };
}
