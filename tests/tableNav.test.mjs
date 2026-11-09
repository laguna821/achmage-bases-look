import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDGE_FAST, EDGE_SLOW, EDGE_ZONE, edgeRamp, edgeSpeed, edgeZone, movesCell, pressSelects } from '../src/tableNav.ts';

const press = (changes = {}) => ({
	button: 0, primary: true, pointerType: 'mouse', ctrl: false, meta: false, alt: false, shift: false,
	onControl: false, editing: false, tableFocused: false, onSelected: false, ...changes,
});

test('a press selects a cell, a second press on the selected cell edits it', () => {
	assert.equal(pressSelects(press()), true);
	// the table holds the focus but another cell is selected: this one gets selected
	assert.equal(pressSelects(press({ tableFocused: true })), true);
	// the cell was selected, but the focus went elsewhere since (the note, another pane): select again
	assert.equal(pressSelects(press({ onSelected: true })), true);
	// the selected cell, pressed again while the table holds the focus: edit it
	assert.equal(pressSelects(press({ tableFocused: true, onSelected: true })), false);
	// Shift + press extends the selection and never edits
	assert.equal(pressSelects(press({ shift: true, tableFocused: true, onSelected: true })), true);
});

test('links, checkboxes, a cell being edited, touch and modifier presses keep Obsidian’s behavior', () => {
	assert.equal(pressSelects(press({ onControl: true })), false);
	assert.equal(pressSelects(press({ editing: true })), false);
	assert.equal(pressSelects(press({ pointerType: 'touch' })), false);
	assert.equal(pressSelects(press({ pointerType: 'pen' })), true);
	assert.equal(pressSelects(press({ primary: false })), false);
	for (const button of [1, 2]) assert.equal(pressSelects(press({ button })), false);
	for (const key of ['ctrl', 'meta', 'alt']) assert.equal(pressSelects(press({ [key]: true })), false, key);
});

test('the keys Bases moves the selected cell with', () => {
	for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Tab']) assert.equal(movesCell(key), true, key);
	for (const key of ['Enter', 'Escape', 'F2', 'a', ' ', 'Shift', 'ArrowRightX']) assert.equal(movesCell(key), false, key);
});

test('the edges of a view move it while there is more to see on that side', () => {
	// a view from 100 to 900 on screen, scrolled 300 of 1200
	assert.deepEqual(edgeZone(100, 100, 900, 300, 1200), { direction: -1, depth: 1 });
	assert.deepEqual(edgeZone(900, 100, 900, 300, 1200), { direction: 1, depth: 1 });
	assert.deepEqual(edgeZone(880, 100, 900, 300, 1200), { direction: 1, depth: 0.5 });
	assert.equal(edgeZone(100 + EDGE_ZONE, 100, 900, 300, 1200), null);
	assert.equal(edgeZone(500, 100, 900, 300, 1200), null);
	// at the start the left edge does nothing, at the end the right edge does nothing
	assert.equal(edgeZone(105, 100, 900, 0, 1200), null);
	assert.deepEqual(edgeZone(895, 100, 900, 0, 1200)?.direction, 1);
	assert.equal(edgeZone(895, 100, 900, 1200, 1200), null);
	assert.deepEqual(edgeZone(105, 100, 900, 1200, 1200)?.direction, -1);
	// nothing to scroll, outside the view, or a view too narrow to have a middle
	assert.equal(edgeZone(895, 100, 900, 0, 0), null);
	assert.equal(edgeZone(95, 100, 900, 300, 1200), null);
	assert.equal(edgeZone(905, 100, 900, 300, 1200), null);
	assert.equal(edgeZone(101, 100, 200, 30, 1200), null);
});

test('a view starts gently and moves faster nearer the edge', () => {
	assert.equal(edgeSpeed(0), EDGE_SLOW);
	assert.equal(edgeSpeed(1), EDGE_FAST);
	assert.equal(edgeSpeed(2), EDGE_FAST);
	assert.equal(edgeSpeed(-1), EDGE_SLOW);
	assert.ok(edgeSpeed(0.25) < edgeSpeed(0.5) && edgeSpeed(0.5) < edgeSpeed(0.75));
	assert.equal(edgeRamp(0), 0.2);
	assert.equal(edgeRamp(10000), 1);
	assert.ok(edgeRamp(100) > 0.2 && edgeRamp(100) < 1);
});
