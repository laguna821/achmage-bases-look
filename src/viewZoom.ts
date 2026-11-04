import { Platform, type App } from 'obsidian';
import { strings } from './i18n';
import { contentWidthOf, relayoutView, viewElementOf, viewScrollerOf } from './native';
import { clampZoom, fitCommandZoom, fitZoom, isFitZoom, stepZoom, wheelPixels, ZoomGesture } from './zoom.ts';

/** Where the zoom of each view is kept: Obsidian's storage of this device, for this vault. */
const STORAGE = 'achmage-bases-look-zoom';
/** Views kept at most; the ones zoomed longest ago go first. */
const MAX_VIEWS = 500;
const BADGE = 'achmage-look-zoom-badge';
const BADGE_MS = 900;

/** A view to zoom: what holds its controller, and the key its zoom is kept under. */
export interface ZoomTarget {
	owner: unknown;
	key: string;
}

/** The key of a view shown in a Bases leaf. */
export function leafZoomKey(basePath: string, viewName: string): string {
	return `tab\n${basePath}\n${viewName}`;
}

/** The key of a view embedded in a note: each note keeps its own zoom of it. */
export function embedZoomKey(notePath: string, basePath: string | null, viewName: string): string {
	return `embed\n${notePath}\n${basePath ?? 'code'}\n${viewName}`;
}

/**
 * Zoom of Bases views, as in a spreadsheet: Ctrl + wheel or a pinch over a view makes its
 * content smaller or larger (the toolbar stays as it is). Kept per view on this device only,
 * as Obsidian keeps folded groups: the base file is never changed.
 */
export class ViewZoom {
	private readonly app: App;
	private readonly changed: (target: ZoomTarget) => void;
	private levels: Record<string, number> | null = null;
	private readonly gesture = new ZoomGesture();
	/** Views this plugin zoomed, to restore when it stops. */
	private readonly zoomed = new Set<HTMLElement>();
	private badge: HTMLElement | null = null;
	private badgeTimer = 0;
	private saveTimer = 0;

	constructor(app: App, changed: (target: ZoomTarget) => void) {
		this.app = app;
		this.changed = changed;
	}

	private all(): Record<string, number> {
		if (!this.levels) {
			const levels: Record<string, number> = {};
			const stored: unknown = this.app.loadLocalStorage(STORAGE);
			if (stored && typeof stored === 'object') {
				for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
					if (typeof value === 'number' && Number.isFinite(value) && value !== 1) levels[key] = clampZoom(value);
				}
			}
			this.levels = levels;
		}
		return this.levels;
	}

	level(key: string): number {
		return this.all()[key] ?? 1;
	}

	/** Show a view at the zoom kept for it. Runs on every redraw and changes nothing when it is right. */
	apply(target: ZoomTarget): void {
		const view = viewElementOf(target.owner);
		if (!view) return;
		const zoom = this.level(target.key);
		const value = zoom === 1 ? '' : String(zoom);
		if (view.style.getPropertyValue('zoom') === value) return;
		if (value) {
			view.style.setProperty('zoom', value);
			this.zoomed.add(view);
		} else {
			view.style.removeProperty('zoom');
			this.zoomed.delete(view);
		}
		relayoutView(target.owner);
	}

	/** True when this is the zoom gesture: Ctrl + wheel, a pinch, and Cmd + wheel on a Mac. */
	static isZoomWheel(event: WheelEvent): boolean {
		return event.ctrlKey || (Platform.isMacOS && event.metaKey);
	}

	/** The wheel turned over a view with the zoom key held (or a pinch): one step per notch. */
	onWheel(event: WheelEvent, target: ZoomTarget): void {
		event.preventDefault();
		const step = this.gesture.feed(wheelPixels(event.deltaY, event.deltaMode), event.timeStamp);
		if (step !== 0) this.step(target, step);
	}

	/** One step in (1) or out (-1); the level at which the view fits its width is a step on the way. */
	step(target: ZoomTarget, direction: 1 | -1): void {
		const current = this.level(target.key);
		this.set(target, stepZoom(current, direction, this.fitOf(target, current)));
	}

	reset(target: ZoomTarget): void {
		this.set(target, 1);
	}

	/** The level at which every column (or kanban column) fits the width of the view. */
	fit(target: ZoomTarget): void {
		const current = this.level(target.key);
		const scroller = viewScrollerOf(target.owner);
		const level = scroller ? fitCommandZoom(current, scroller.clientWidth, contentWidthOf(scroller)) : null;
		this.set(target, level ?? current);
	}

	destroy(): void {
		window.clearTimeout(this.badgeTimer);
		window.clearTimeout(this.saveTimer);
		this.badge?.detach();
		this.badge = null;
		for (const view of this.zoomed) view.style.removeProperty('zoom');
		this.zoomed.clear();
	}

	private fitOf(target: ZoomTarget, current: number): number | null {
		const scroller = viewScrollerOf(target.owner);
		return scroller ? fitZoom(current, scroller.clientWidth, contentWidthOf(scroller)) : null;
	}

	private set(target: ZoomTarget, zoom: number): void {
		const next = clampZoom(zoom);
		const levels = this.all();
		delete levels[target.key];
		if (next !== 1) {
			levels[target.key] = next;
			const keys = Object.keys(levels);
			for (const old of keys.slice(0, Math.max(0, keys.length - MAX_VIEWS))) delete levels[old];
		}
		this.apply(target);
		this.show(target, next);
		this.changed(target);
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.app.saveLocalStorage(STORAGE, Object.keys(levels).length > 0 ? levels : null), 400);
	}

	/** A small label at the top of the view while the zoom changes: "62% · Fit width". */
	private show(target: ZoomTarget, zoom: number): void {
		const view = viewElementOf(target.owner);
		if (!view) return;
		const doc = view.doc;
		const fit = isFitZoom(zoom, this.fitOf(target, zoom));
		if (!this.badge || this.badge.doc !== doc) {
			this.badge?.detach();
			this.badge = doc.body.createDiv({ cls: BADGE, attr: { 'aria-live': 'polite' } });
		}
		const badge = this.badge;
		badge.setText(strings().zoomBadge(Math.round(zoom * 100), fit));
		const rect = view.getBoundingClientRect();
		const top = Math.max(8, Math.min(rect.top + 10, doc.documentElement.clientHeight - 40));
		badge.setCssStyles({ top: `${top}px`, right: `${Math.max(8, doc.documentElement.clientWidth - rect.right + 12)}px` });
		badge.removeClass('is-fading');
		window.clearTimeout(this.badgeTimer);
		this.badgeTimer = window.setTimeout(() => {
			badge.addClass('is-fading');
			this.badgeTimer = window.setTimeout(() => {
				if (this.badge === badge) this.badge = null;
				badge.detach();
			}, 300);
		}, BADGE_MS);
	}
}
