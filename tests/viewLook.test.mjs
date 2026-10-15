import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStoredViewLook, resolveViewLook, writeViewLook } from '../src/viewLook.ts';
import { fitTableColumns, viewAspect } from '../src/baseConfig.ts';

const defaults = {
	listSize: 45, shape: null, fit: 'cover', placeholders: true, tidy: true, hoverLift: true, hoverRows: true, hoverColor: null,
	groupStyle: { background: true, tint: 10, border: true, heading: true },
};

const sample = () => ({
	achmageLook: { groupColors: { 완료: '#E5484D' }, thumbnailShape: 'wide', listSize: 70, groupStyle: { border: false } },
	views: [
		{ type: 'kanban', name: '칸반', columnWidth: 300, myOwnKey: 'kept' },
		{ type: 'list', name: '목록', order: ['formula.cover'] },
		{ type: 'table', name: '표', order: ['formula.cover'], rowHeight: 'tall' },
	],
	formulas: { cover: 'image(note.cover)' },
});

test('a view uses its own look, then what the base stored before, then the defaults', () => {
	const base = sample();
	const list = resolveViewLook(base, '목록', defaults);
	// earlier versions stored these for the whole base: they still apply, nothing is rewritten
	assert.equal(list.shape, 'wide');
	assert.equal(list.listSize, 70);
	assert.deepEqual(list.groupStyle, { background: true, tint: 10, border: false, heading: true });
	assert.equal(list.hoverRows, true);
	writeViewLook(base, '목록', { listSize: 20, shape: 'square', hoverRows: false, groupStyle: { background: false } });
	const changed = resolveViewLook(base, '목록', defaults);
	assert.deepEqual([changed.listSize, changed.shape, changed.hoverRows, changed.groupStyle.background, changed.groupStyle.border], [20, 'square', false, false, false]);
	// the other views keep theirs
	const table = resolveViewLook(base, '표', defaults);
	assert.deepEqual([table.listSize, table.shape, table.hoverRows, table.groupStyle.background], [70, 'wide', true, true]);
	assert.deepEqual(readStoredViewLook(base, '표'), {});
});

test('writeViewLook touches only the named view and keeps its other keys', () => {
	const base = sample();
	const before = JSON.parse(JSON.stringify(base));
	assert.equal(writeViewLook(base, '칸반', { hoverLift: false, hoverColor: '#E5484D' }), true);
	assert.deepEqual(base.views[0], { type: 'kanban', name: '칸반', columnWidth: 300, myOwnKey: 'kept', achmageLook: { hoverLift: false, hoverColor: '#E5484D' } });
	assert.deepEqual(base.views[1], before.views[1]);
	assert.deepEqual(base.views[2], before.views[2]);
	assert.deepEqual(base.achmageLook, before.achmageLook);
	// clearing every value removes the key again
	writeViewLook(base, '칸반', { hoverLift: null, hoverColor: null });
	assert.equal(base.views[0].achmageLook, undefined);
	assert.equal(writeViewLook(base, 'missing', { tidy: false }), false);
});

test('each table and list view has its own thumbnail shape, and table columns follow it', () => {
	const base = sample();
	assert.equal(viewAspect(base, base.views[1], 'cover'), 0.5625);
	writeViewLook(base, '표', { shape: 'square' });
	assert.equal(viewAspect(base, base.views[2], 'cover'), 1);
	assert.equal(viewAspect(base, base.views[1], 'cover'), 0.5625);
	fitTableColumns(base, 'cover');
	assert.equal(base.views[2].columnSize['formula.cover'], 126);
	assert.equal(viewAspect(base, base.views[0], 'cover'), 0.5);
});
