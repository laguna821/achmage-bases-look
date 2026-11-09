import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampZoom, fitCommandZoom, fitZoom, isFitZoom, MAX_ZOOM, MIN_ZOOM, stepZoom, wheelPixels, ZoomGesture, ZOOM_STEPS } from '../src/zoom.ts';
import { embedLookOf, resolveViewLook, writeViewLook } from '../src/viewLook.ts';

test('the wheel steps through the levels and stops at the ends', () => {
	assert.equal(stepZoom(1, -1, null), 0.9);
	assert.equal(stepZoom(1, 1, null), 1.1);
	assert.equal(stepZoom(1.25, 1, null), 1.5);
	assert.equal(stepZoom(MAX_ZOOM, 1, null), MAX_ZOOM);
	assert.equal(stepZoom(MIN_ZOOM, -1, null), MIN_ZOOM);
	// from a level between two steps, the next step in that direction
	assert.equal(stepZoom(0.63, -1, null), 0.6);
	assert.equal(stepZoom(0.63, 1, null), 0.7);
	// every step is reached on the way down
	const seen = [];
	for (let z = MAX_ZOOM; z > MIN_ZOOM; z = stepZoom(z, -1, null)) seen.push(z);
	assert.deepEqual([...seen, MIN_ZOOM].reverse(), [...ZOOM_STEPS]);
});

test('the fit level is a stop on the way, and a step close to it gives way to it', () => {
	assert.equal(stepZoom(0.7, -1, 0.63), 0.63);
	assert.equal(stepZoom(0.63, -1, 0.63), 0.6);
	assert.equal(stepZoom(0.6, 1, 0.63), 0.63);
	// 0.394 is next to 0.4: the stop is 0.394, where the content really fits, and 0.4 is skipped
	assert.equal(stepZoom(0.5, -1, 0.394), 0.394);
	assert.equal(stepZoom(0.394, -1, 0.394), 0.3);
	assert.equal(stepZoom(0.3, 1, 0.394), 0.394);
	assert.equal(stepZoom(0.394, 1, 0.394), 0.5);
	// a level kept from before, next to the fit level measured now, moves on from there
	assert.equal(stepZoom(0.4, -1, 0.394), 0.394);
	assert.equal(stepZoom(0.392, 1, 0.394), 0.5);
	// only the level itself is the fit level, measured again at that level
	assert.equal(isFitZoom(0.393, 0.394), true);
	assert.equal(isFitZoom(0.4, 0.394), false);
	assert.equal(isFitZoom(1, null), false);
});

test('the fit level makes the content as wide as the room it has', () => {
	// 1001px of room at 100% (one is kept to spare), 2500px of content: 40%
	assert.equal(fitZoom(1, 1001, 2500), 0.4);
	// measured at 50%, the room is twice as wide in the view's own pixels
	assert.equal(fitZoom(0.5, 2001, 2500), 0.4);
	// rounded down, so it fits: the table of the test vault, measured at 50%
	assert.equal(fitZoom(0.5, 2180, 2767), 0.393);
	assert.ok(0.393 * 2767 <= 0.5 * 2180);
	// content narrower than the view still has its fit level (the view stretches it)
	assert.equal(fitZoom(0.3, 3642, 2767), 0.394);
	// no stop when the content fits at 100%, is too wide even at the smallest level, or has no width
	assert.equal(fitZoom(1, 1000, 900), null);
	assert.equal(fitZoom(1, 100, 9000), null);
	assert.equal(fitZoom(1, 0, 900), null);
	assert.equal(fitZoom(1, 1000, null), null);
	// "fit to width" goes to 100% or the smallest level then
	assert.equal(fitCommandZoom(0.5, 2600, 1000), 1);
	assert.equal(fitCommandZoom(1, 100, 9000), MIN_ZOOM);
	assert.equal(fitCommandZoom(0.5, 2180, 2767), 0.393);
	assert.equal(fitCommandZoom(1, 1000, null), null);
});

test('levels stay within the range', () => {
	assert.equal(clampZoom(0.1), MIN_ZOOM);
	assert.equal(clampZoom(9), MAX_ZOOM);
	assert.equal(clampZoom(Number.NaN), 1);
	assert.equal(clampZoom(0.6666666), 0.667);
});

test('a wheel notch is one step; a pinch adds up first', () => {
	const gesture = new ZoomGesture();
	assert.equal(gesture.feed(-100, 0), 1);
	assert.equal(gesture.feed(100, 50), -1);
	assert.equal(gesture.feed(0, 60), 0);
	// small movements of a pinch
	const pinch = new ZoomGesture();
	assert.equal(pinch.feed(-15, 1000), 0);
	assert.equal(pinch.feed(-15, 1016), 0);
	assert.equal(pinch.feed(-15, 1032), 1);
	assert.equal(pinch.feed(-15, 1048), 0);
	// a pause starts over
	assert.equal(pinch.feed(-30, 2000), 0);
	assert.equal(pinch.feed(20, 2016), 0);
	assert.equal(pinch.feed(25, 2032), 0);
	assert.equal(pinch.feed(25, 2048), -1);
	// lines and pages are counted in pixels
	assert.equal(wheelPixels(3, 1), 48);
	assert.equal(wheelPixels(1, 2), 800);
	assert.equal(wheelPixels(-120, 0), -120);
});

test('group counts, wide embeds, cell selection and edge moves are on unless a view turns them off', () => {
	const defaults = {
		listSize: 45, shape: null, fit: 'cover', placeholders: true, tidy: true, hoverLift: true, hoverRows: true, hoverColor: null,
		groupStyle: { background: true, tint: 10, border: true, heading: true }, groupCounts: true, wideEmbed: true, cellSelect: true, edgeScroll: true,
	};
	const on = { groupCounts: true, wideEmbed: true, cellSelect: true, edgeScroll: true };
	const base = { views: [{ type: 'list', name: '목록' }, { type: 'table', name: '표' }] };
	const table = () => resolveViewLook(base, '표', defaults);
	assert.deepEqual([resolveViewLook(base, '목록', defaults).groupCounts, table().wideEmbed, table().cellSelect, table().edgeScroll], [true, true, true, true]);
	writeViewLook(base, '표', { wideEmbed: false, groupCounts: false, cellSelect: false, edgeScroll: false });
	assert.deepEqual(base.views[1].achmageLook, { wideEmbed: false, groupCounts: false, cellSelect: false, edgeScroll: false });
	assert.deepEqual([table().wideEmbed, table().cellSelect, table().edgeScroll], [false, false, false]);
	assert.equal(resolveViewLook(base, '목록', defaults).wideEmbed, true);
	assert.equal(resolveViewLook(base, '목록', defaults).cellSelect, true);
	// an embedded base reads the same values from the view's achmageLook in memory
	assert.deepEqual(embedLookOf(base.views[1].achmageLook, defaults), { groupCounts: false, wideEmbed: false, cellSelect: false, edgeScroll: false });
	assert.deepEqual(embedLookOf(undefined, defaults), on);
	assert.deepEqual(embedLookOf({ wideEmbed: 'no', cellSelect: 0 }, defaults), on);
	// turning them back on removes the keys: the file is as it was
	writeViewLook(base, '표', { wideEmbed: null, groupCounts: null, cellSelect: null, edgeScroll: null });
	assert.equal(base.views[1].achmageLook, undefined);
	assert.deepEqual(base.views[1], { type: 'table', name: '표' });
});
