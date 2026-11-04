// Zoom levels of a Bases view: the steps of the wheel, the level at which the view fits the width
// it has, and turning wheel and pinch movement into steps. Pure, so the tests can run it in Node.

/** The levels the wheel steps through, from the smallest to the largest. */
export const ZOOM_STEPS: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 1.5;
/** A step this close to the fit level gives way to it. */
const SAME = 0.02;
/** A level this close to the fit level is that level (it was measured at another level). */
const AT_FIT = 0.004;
/** One notch of a mouse wheel moves at least this far. */
const NOTCH = 50;
/** Smaller movements (a pinch, a fine wheel) add up to one step at this distance. */
const PINCH_STEP = 40;
/** Movements further apart than this do not add up. */
const PAUSE_MS = 400;

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 1000) / 1000));
}

/** The exact level for content `total` wide in `visible`, both measured at `current`. */
function rawFit(current: number, visible: number, total: number | null): number | null {
	if (total === null || !(current > 0) || !(visible > 1) || !(total > 0)) return null;
	// One pixel to spare, so that rounding never leaves a scrollbar.
	return (current * (visible - 1)) / total;
}

/** A level rounded down, so the content still fits at it. */
const down = (level: number): number => Math.floor(level * 1000) / 1000;

/**
 * The level at which content `total` wide fits in `visible`, both measured at the level `current`
 * (in the view's own pixels; null when the content has no width of its own). Null when it is not
 * a stop of the wheel: the content fits at 100%, or it is too wide even at the smallest level.
 */
export function fitZoom(current: number, visible: number, total: number | null): number | null {
	const fit = rawFit(current, visible, total);
	return fit === null || fit >= 1 || fit < MIN_ZOOM ? null : down(fit);
}

/**
 * Where "fit to width" goes: the fit level, 100% when the content fits at 100%, the smallest level
 * when it is wider than that. Null when the content has no width of its own.
 */
export function fitCommandZoom(current: number, visible: number, total: number | null): number | null {
	const fit = rawFit(current, visible, total);
	if (fit === null) return null;
	return fit >= 1 ? 1 : fit < MIN_ZOOM ? MIN_ZOOM : down(fit);
}

/** True when a level is the fit level (measured again at that level). */
export function isFitZoom(zoom: number, fit: number | null): boolean {
	return fit !== null && Math.abs(zoom - fit) <= AT_FIT;
}

/**
 * The level one step from `current`: in (1) or out (-1). The fit level is a stop on the way, and
 * a step close to it gives way to it, so the stop there is the level that really fits.
 */
export function stepZoom(current: number, direction: 1 | -1, fit: number | null): number {
	let levels = [...ZOOM_STEPS];
	if (fit !== null && fit >= MIN_ZOOM && fit < MAX_ZOOM) {
		levels = levels.filter((step) => Math.abs(step - fit) >= SAME);
		levels.push(fit);
	}
	levels.sort((a, b) => a - b);
	if (direction > 0) return levels.find((level) => level > current + 0.005) ?? MAX_ZOOM;
	for (let i = levels.length - 1; i >= 0; i--) {
		const level = levels[i];
		if (level !== undefined && level < current - 0.005) return level;
	}
	return MIN_ZOOM;
}

/** Wheel movement in pixels, whatever unit the device reports it in. */
export function wheelPixels(delta: number, mode: number): number {
	if (mode === 1) return delta * 16;
	if (mode === 2) return delta * 800;
	return delta;
}

/**
 * Turns wheel and pinch movement into zoom steps: one notch of a mouse wheel is one step, the
 * small movements of a pinch or a fine wheel add up to one. Wheel up (negative) zooms in.
 */
export class ZoomGesture {
	private sum = 0;
	private last = -Infinity;

	feed(pixels: number, now: number): -1 | 0 | 1 {
		if (now - this.last > PAUSE_MS) this.sum = 0;
		this.last = now;
		if (!Number.isFinite(pixels) || pixels === 0) return 0;
		if (Math.abs(pixels) >= NOTCH) {
			this.sum = 0;
			return pixels < 0 ? 1 : -1;
		}
		this.sum += pixels;
		if (Math.abs(this.sum) < PINCH_STEP) return 0;
		const step = this.sum < 0 ? 1 : -1;
		this.sum = 0;
		return step;
	}
}
