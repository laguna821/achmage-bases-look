import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectThumbnailProperty, formulaImageProperty, readStoredSettings, resolveBaseSettings, writeStoredSettings } from '../src/baseSettings.ts';
import { disable, enable, fitTableColumns, isEnabled, moveThumbnailProperty } from '../src/baseConfig.ts';

const defaults = { property: '썸네일', linkProperty: '링크', folder: '썸네일', autoKanbanGroup: true, listSize: 45 };

test('each base uses its own setting, then what it already shows, then the defaults', () => {
	assert.equal(resolveBaseSettings({ views: [] }, defaults).thumbnailProperty, '썸네일');
	assert.equal(resolveBaseSettings({ views: [] }, defaults).thumbnailSource, 'default');
	const cover = { views: [{ type: 'table' }, { type: 'cards', image: 'note.cover' }] };
	assert.deepEqual([resolveBaseSettings(cover, defaults).thumbnailProperty, resolveBaseSettings(cover, defaults).thumbnailSource], ['cover', 'detected']);
	const formula = { formulas: { 표지: 'image(note["my banner"])', other: 'file.name' }, views: [{ type: 'table', order: ['formula.표지', 'file.name'] }] };
	assert.equal(resolveBaseSettings(formula, defaults).thumbnailProperty, 'my banner');
	const unused = { formulas: { 표지: 'image(note.banner)' }, views: [{ type: 'table', order: ['file.name'] }] };
	assert.equal(resolveBaseSettings(unused, defaults).thumbnailSource, 'default');
	const stored = { achmageLook: { thumbnailProperty: 'poster', linkProperty: 'url', imageFolder: 'covers', autoKanbanGroup: false, listSize: 80 }, views: [{ type: 'cards', image: 'note.cover' }] };
	const s = resolveBaseSettings(stored, defaults);
	assert.deepEqual([s.thumbnailProperty, s.thumbnailSource, s.linkProperty, s.imageFolder, s.autoKanbanGroup, s.listSize], ['poster', 'base', 'url', 'covers', false, 80]);
});

test('file and formula images are told apart from note properties', () => {
	assert.deepEqual(detectThumbnailProperty({ views: [{ type: 'cards', image: 'file.file' }] }), { property: null, external: true });
	assert.deepEqual(detectThumbnailProperty({ views: [{ type: 'kanban', image: 'formula.pic' }, { type: 'cards', image: 'cover' }] }), { property: 'cover', external: true });
	assert.equal(formulaImageProperty(' image( note.썸네일 ) '), '썸네일');
	assert.equal(formulaImageProperty('image(file.file)'), null);
	assert.equal(formulaImageProperty('if(x, image(note.a), "")'), null);
});

test('writeStoredSettings sets and clears values without touching the rest of achmageLook', () => {
	const base = { achmageLook: { groupColors: { 완료: '#E5484D' } } };
	writeStoredSettings(base, { thumbnailProperty: ' cover ', listSize: 70 });
	assert.deepEqual(readStoredSettings(base), { thumbnailProperty: 'cover', listSize: 70 });
	writeStoredSettings(base, { thumbnailProperty: null, listSize: null });
	assert.deepEqual(base.achmageLook, { groupColors: { 완료: '#E5484D' } });
	const empty = { achmageLook: { listSize: 10 } };
	writeStoredSettings(empty, { listSize: null });
	assert.equal(empty.achmageLook, undefined);
});

test('turning thumbnails on fills only empty views and never replaces the user setup', () => {
	const base = {
		formulas: { 표지: 'image(note.banner)' },
		views: [
			{ type: 'cards', name: 'A', image: 'note.cover', imageAspectRatio: 1.5, imageFit: 'contain', cardSize: 300 },
			{ type: 'kanban', name: 'B' },
			{ type: 'cards', name: 'C', image: 'file.file' },
			{ type: 'table', name: 'D', order: ['file.name', 'formula.표지'] },
			{ type: 'list', name: 'E', order: ['file.name'] },
		],
	};
	enable(base, 'cover', 'wide');
	assert.deepEqual(base.views[0], { type: 'cards', name: 'A', image: 'note.cover', imageAspectRatio: 1.5, imageFit: 'contain', cardSize: 300 });
	assert.equal(base.views[1].image, 'note.cover');
	assert.equal(base.views[1].imageAspectRatio, 0.5625);
	assert.equal(base.views[2].image, 'file.file');
	// a table that already shows an image() column keeps its own order
	assert.deepEqual(base.views[3].order, ['file.name', 'formula.표지']);
	assert.deepEqual(base.views[4].order, ['formula.cover', 'file.name']);
	assert.equal(base.formulas.표지, 'image(note.banner)');
	assert.equal(base.achmageLook.thumbnailProperty, 'cover');
	// off, then on again: the remembered property is kept, the user's formula stays defined
	disable(base, 'cover');
	assert.equal(base.views[0].image, undefined);
	assert.equal(base.formulas.표지, 'image(note.banner)');
	assert.equal(base.formulas.cover, undefined);
	assert.equal(resolveBaseSettings(base, defaults).thumbnailProperty, 'cover');
	enable(base, resolveBaseSettings(base, defaults).thumbnailProperty, null);
	assert.equal(base.views[0].image, 'note.cover');
	assert.equal(isEnabled(base, 'cover'), true);
});

test('a formula view already showing the property keeps its column where it is', () => {
	const base = { formulas: { 표지: 'image(note.cover)' }, views: [{ type: 'table', name: 'T', order: ['file.name', 'formula.표지'] }] };
	enable(base, 'cover', null);
	assert.deepEqual(base.views[0].order, ['file.name', 'formula.표지']);
	assert.deepEqual(Object.keys(base.formulas), ['표지']);
});

test('a column width the user set stays; the one fitted here follows the shape', () => {
	const base = { views: [{ type: 'table', name: 'T', order: ['file.name'], rowHeight: 'tall' }] };
	enable(base, 'cover', 'square');
	assert.equal(base.views[0].columnSize['formula.cover'], 126);
	base.achmageLook.thumbnailShape = 'wide';
	fitTableColumns(base, 'cover');
	assert.equal(base.views[0].columnSize['formula.cover'], 215);
	base.views[0].columnSize['formula.cover'] = 300;
	base.achmageLook.thumbnailShape = 'square';
	fitTableColumns(base, 'cover');
	assert.equal(base.views[0].columnSize['formula.cover'], 300);
});

test('moving a base to another thumbnail property changes the base, not the notes', () => {
	const base = { formulas: { cover: 'image(note.cover)' }, views: [{ type: 'cards', image: 'note.cover' }, { type: 'cards', image: 'note.other' }, { type: 'list', order: ['formula.cover'] }] };
	moveThumbnailProperty(base, 'cover', 'banner');
	assert.equal(base.views[0].image, 'note.banner');
	assert.equal(base.views[1].image, 'note.other');
	assert.equal(base.formulas.cover, 'image(note.banner)');
});

test('turning off a base that only showed its property remembers the property', () => {
	const base = { views: [{ type: 'cards', name: 'A', image: 'note.cover', imageAspectRatio: 1.5 }] };
	assert.equal(resolveBaseSettings(base, defaults).thumbnailSource, 'detected');
	disable(base, 'cover');
	assert.equal(base.views[0].image, undefined);
	assert.equal(base.views[0].imageAspectRatio, 1.5);
	assert.equal(resolveBaseSettings(base, defaults).thumbnailProperty, 'cover');
	enable(base, 'cover', 'square');
	assert.deepEqual(base.views[0], { type: 'cards', name: 'A', image: 'note.cover', imageAspectRatio: 1.5 });
});
