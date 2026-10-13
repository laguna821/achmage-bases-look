import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	enable, disable, isEnabled, applyLook, readLook, findThumbnailFormula, thumbnailFormula, cardSizeFor, columnWidthFor, rowHeightFor, listPixelsFor, thumbnailAspect, tableColumnWidth,
} from '../src/baseConfig.ts';

const sample = () => ({
	filters: { and: ['file.inFolder("작품")'] },
	views: [
		{ type: 'kanban', name: 'Board', groupBy: { property: 'note.상태', direction: 'ASC' }, order: ['file.name'] },
		{ type: 'cards', name: 'Cards', order: ['file.name'] },
		{ type: 'table', name: 'Table', order: ['file.name', 'note.장르'] },
		{ type: 'list', name: 'List' },
		{ type: 'map', name: 'Map' },
	],
});

const look = { size: null, ratio: 'landscape', fit: null };


test('enable sets the image property on cover views and a formula column on table and list', () => {
	const base = enable(sample(), '썸네일', look);
	assert.equal(base.views[0].image, 'note.썸네일');
	assert.equal(base.views[1].image, 'note.썸네일');
	assert.equal(base.views[0].imageAspectRatio, 0.75);
	assert.deepEqual(base.views[2].order, ['formula.썸네일', 'file.name', 'note.장르']);
	assert.deepEqual(base.views[3].order, ['formula.썸네일', 'file.name']);
	assert.equal(base.views[2].rowHeight, 'tall');
	assert.equal(base.views[3].rowHeight, undefined);
	assert.equal(base.formulas['썸네일'], 'image(note.썸네일)');
	assert.equal(base.views[4].image, undefined);
	assert.equal(isEnabled(base, '썸네일'), true);
});

test('enable twice does not duplicate the formula column', () => {
	const base = enable(enable(sample(), 'cover', look), 'cover', look);
	assert.deepEqual(base.views[2].order, ['formula.cover', 'file.name', 'note.장르']);
	assert.deepEqual(Object.keys(base.formulas), ['cover']);
});

test('a formula name that is taken by something else gets a new name', () => {
	const base = sample();
	base.formulas = { cover: 'file.name' };
	enable(base, 'cover', look);
	assert.equal(base.formulas.cover, 'file.name');
	assert.equal(base.formulas['cover 2'], 'image(note.cover)');
	assert.equal(findThumbnailFormula(base, 'cover'), 'cover 2');
});

test('property names with spaces use bracket syntax in the formula', () => {
	assert.equal(thumbnailFormula('my cover'), 'image(note["my cover"])');
	assert.equal(thumbnailFormula('썸네일'), 'image(note.썸네일)');
});

test('disable removes only what enable added', () => {
	const base = enable(sample(), 'cover', look);
	base.views[0].groupBy = { property: 'note.상태', direction: 'ASC' };
	disable(base, 'cover');
	assert.equal(base.views[0].image, undefined);
	assert.deepEqual(base.views[2].order, ['file.name', 'note.장르']);
	assert.equal(base.formulas, undefined);
	assert.equal(isEnabled(base, 'cover'), false);
	assert.deepEqual(base.views[0].groupBy, { property: 'note.상태', direction: 'ASC' });
});

test('disable keeps image settings that point at another property', () => {
	const base = sample();
	base.views[0].image = 'note.poster';
	disable(base, 'cover');
	assert.equal(base.views[0].image, 'note.poster');
});

test('an image setting without the note. prefix counts as enabled', () => {
	const base = sample();
	base.views[0].image = 'cover';
	assert.equal(isEnabled(base, 'cover'), true);
});

test('applyLook writes size, shape and fit per view type and readLook reads them back', () => {
	const base = enable(sample(), 'cover', look);
	applyLook(base, 'cover', { size: 80, ratio: 'poster', fit: 'contain' });
	assert.equal(base.views[0].columnWidth, 412);
	assert.equal(base.views[1].cardSize, 348);
	assert.equal(base.views[1].imageAspectRatio, 1.5);
	assert.equal(base.views[1].imageFit, 'contain');
	assert.equal(base.views[2].rowHeight, 'extra');
	assert.deepEqual(readLook(base, 'cover'), { size: 80, ratio: 'poster', fit: 'contain' });
	applyLook(base, 'cover', { fit: 'cover' });
	assert.equal(base.views[1].imageFit, undefined);
});

test('a base without views is left alone', () => {
	const base = enable({ filters: {} }, 'cover', look);
	assert.equal(isEnabled(base, 'cover'), false);
	assert.equal(base.formulas, undefined);
});

test('the size scale maps to every view type and back', () => {
	assert.equal(cardSizeFor(0), 140);
	assert.equal(cardSizeFor(100), 400);
	assert.equal(columnWidthFor(45), 328);
	assert.equal(rowHeightFor(10), 'medium');
	assert.equal(rowHeightFor(50), 'tall');
	assert.equal(rowHeightFor(90), 'extra');
	assert.equal(listPixelsFor(150), 120);
	const base = { views: [{ type: 'table', order: ['file.name'] }] };
	enable(base, 'cover', { size: null, ratio: null, fit: null });
	applyLook(base, 'cover', { size: 90 });
	assert.equal(readLook(base, 'cover').size, 80);
});

test('shape and fit reach table and list views even without card views', () => {
	const base = { views: [{ type: 'table', order: ['file.name'] }, { type: 'list' }] };
	enable(base, 'cover', { size: null, ratio: null, fit: null });
	assert.equal(thumbnailAspect(base, 'cover'), 1);
	applyLook(base, 'cover', { ratio: 'wide', fit: 'contain' });
	assert.equal(thumbnailAspect(base, 'cover'), 0.5625);
	assert.deepEqual(readLook(base, 'cover'), { size: 45, ratio: 'wide', fit: 'contain' });
	const withCards = enable({ views: [{ type: 'cards' }, { type: 'list' }] }, 'cover', { size: null, ratio: 'poster', fit: null });
	assert.equal(thumbnailAspect(withCards, 'cover'), 1.5);
});

test('the table thumbnail column is widened to fit the shape', () => {
	assert.equal(tableColumnWidth('tall', 1), 126);
	assert.equal(tableColumnWidth('tall', 0.75), 164);
	assert.equal(tableColumnWidth('extra', 0.5625), 420);
	const base = enable({ views: [{ type: 'table', order: ['file.name'], columnSize: { 'file.name': 200 } }] }, 'cover', { size: null, ratio: 'wide', fit: null });
	assert.deepEqual(base.views[0].columnSize, { 'file.name': 200, 'formula.cover': 215 });
});

test('one view can be changed and have thumbnails on or off on its own', async () => {
	const { summarizeViews, updateView, setViewThumbnails } = await import('../src/baseConfig.ts');
	const base = { views: [{ type: 'kanban', name: 'Board' }, { type: 'table', name: 'Table', order: ['file.name'] }] };
	setViewThumbnails(base, 'Table', 'cover', true);
	updateView(base, 'Board', { columnWidth: 320, imageFit: 'contain' });
	let [board, table] = summarizeViews(base, 'cover');
	assert.equal(board.thumbnails, false);
	assert.equal(board.columnWidth, 320);
	assert.equal(board.imageFit, 'contain');
	assert.equal(table.thumbnails, true);
	assert.equal(table.rowHeight, 'tall');
	setViewThumbnails(base, 'Board', 'cover', true);
	updateView(base, 'Board', { imageFit: null, type: 'cards' });
	[board] = summarizeViews(base, 'cover');
	assert.deepEqual([board.type, board.thumbnails, board.imageFit], ['cards', true, 'cover']);
	setViewThumbnails(base, 'Table', 'cover', false);
	assert.deepEqual(base.views[1].order, ['file.name']);
});

test('thumbnails follow a view through layout changes', async () => {
	const { carryThumbnails, setViewThumbnails, isEnabled } = await import('../src/baseConfig.ts');
	const base = enable({ views: [{ type: 'kanban', name: 'A', order: ['file.name'] }, { type: 'table', name: 'B', order: ['file.name'] }] }, 'cover', { size: null, ratio: null, fit: null });
	// kanban → list: Obsidian keeps `image`, the list needs the formula column
	base.views[0].type = 'list';
	assert.equal(carryThumbnails(base, 'cover', ['A']), true);
	assert.deepEqual(base.views[0].order, ['formula.cover', 'file.name']);
	assert.equal(base.views[0].image, undefined);
	// table → cards: the column becomes `image` and leaves the card's property list
	base.views[1].type = 'cards';
	carryThumbnails(base, 'cover', ['B']);
	assert.equal(base.views[1].image, 'note.cover');
	assert.deepEqual(base.views[1].order, ['file.name']);
	assert.equal(carryThumbnails(base, 'cover', ['A', 'B']), false);
	// turning a view off removes both settings, so a later layout change cannot revive it
	const stale = { formulas: { cover: 'image(note.cover)' }, views: [{ type: 'list', name: 'C', image: 'note.cover', order: ['formula.cover', 'file.name'] }] };
	setViewThumbnails(stale, 'C', 'cover', false);
	assert.equal(stale.views[0].image, undefined);
	assert.deepEqual(stale.views[0].order, ['file.name']);
	// switching the whole base off clears leftovers in every layout
	const mixed = { formulas: { cover: 'image(note.cover)' }, views: [{ type: 'list', name: 'D', image: 'note.cover', order: ['formula.cover'] }, { type: 'kanban', name: 'E', image: 'note.cover', order: ['formula.cover', 'file.name'] }] };
	disable(mixed, 'cover');
	assert.equal(mixed.views[0].image, undefined);
	assert.equal(mixed.views[1].image, undefined);
	assert.deepEqual(mixed.views[1].order, ['file.name']);
	assert.equal(isEnabled(mixed, 'cover'), false);
});
