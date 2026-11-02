import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	clearTableFormat, fitRowPreset, formatCounts, narrowestFit, nearestRowPreset, NO_COLOR, PALETTE, PALETTE_NAMES, planChange,
	readTableFormat, renameNotePaths, rowPixels, shownCell, shownHeader, writeTableFormat,
} from '../src/tableFormat.ts';
import { writeViewLook } from '../src/viewLook.ts';

const NOTE = '01. Inbox/손끝으로 기억할게요.md';
const OTHER = '01. Inbox/다른 영화.md';

const sample = () => ({
	achmageLook: { thumbnailProperty: '썸네일', fittedColumns: { 뷰: 164 } },
	formulas: { 썸네일: 'image(note.썸네일)' },
	views: [
		{
			type: 'table', name: '뷰', order: ['formula.썸네일', 'file.name', '평점'],
			columnSize: { 'file.name': 192 }, rowHeight: 'tall', achmageLook: { shape: 'landscape', fit: 'contain' },
		},
		{ type: 'cards', name: '카드', image: 'note.썸네일', myOwnKey: 'kept' },
	],
});

const copy = (value) => JSON.parse(JSON.stringify(value));

test('reading keeps valid values only', () => {
	const base = sample();
	base.views[0].achmageLook.format = {
		header: { 'note.평점': { light: { fill: 'dbebfb', text: '#nothex' }, dark: { fill: 'none' }, bold: true, align: 'middle' } },
		columns: { 'note.한줄평': { italic: 'yes' } },
		rows: { [NOTE]: { light: { fill: '#E0F' } } },
		cells: { [NOTE]: { 'note.평점': { align: 'right' }, 'note.빈칸': {} } },
	};
	const format = readTableFormat(base, '뷰');
	assert.deepEqual(format.header, { 'note.평점': { light: { fill: '#DBEBFB' }, dark: { fill: NO_COLOR }, bold: true } });
	assert.deepEqual(format.columns, {});
	assert.deepEqual(format.rows, { [NOTE]: { light: { fill: '#EE00FF' } } });
	assert.deepEqual(format.cells, { [NOTE]: { 'note.평점': { align: 'right' } } });
	assert.deepEqual(readTableFormat(base, '카드'), { header: {}, columns: {}, rows: {}, cells: {} });
	assert.deepEqual(readTableFormat(base, 'missing'), { header: {}, columns: {}, rows: {}, cells: {} });
});

test('writing touches only the format of the named view', () => {
	const base = sample();
	const before = copy(base);
	assert.equal(writeTableFormat(base, '뷰', { kind: 'header', props: ['note.평점'] }, { theme: 'light', fill: '#dcebfb', text: '#1D5FB8' }), true);
	assert.equal(writeTableFormat(base, '뷰', { kind: 'header', props: ['note.평점'] }, { bold: true, align: 'center' }), true);
	assert.deepEqual(base.views[0].achmageLook, {
		shape: 'landscape', fit: 'contain',
		format: { header: { 'note.평점': { light: { fill: '#DCEBFB', text: '#1D5FB8' }, bold: true, align: 'center' } } },
	});
	// everything else is as it was, Obsidian's own keys included
	const { achmageLook: _look, ...restOfView } = base.views[0];
	const { achmageLook: _was, ...restBefore } = before.views[0];
	assert.deepEqual(restOfView, restBefore);
	assert.deepEqual(base.views[1], before.views[1]);
	assert.deepEqual(base.achmageLook, before.achmageLook);
	assert.deepEqual(base.formulas, before.formulas);
	// a missing view changes nothing
	assert.equal(writeTableFormat(base, 'missing', { kind: 'column', props: ['file.name'] }, { bold: true }), false);
});

test('light and dark colors are kept apart', () => {
	const base = sample();
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { theme: 'light', fill: PALETTE.light.fill.blue });
	const format = readTableFormat(base, '뷰');
	assert.equal(shownCell(format, NOTE, 'note.평점', 'light').fill, PALETTE.light.fill.blue);
	assert.equal(shownCell(format, NOTE, 'note.평점', 'dark').fill, null);
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { theme: 'dark', fill: PALETTE.dark.fill.blue });
	const both = readTableFormat(base, '뷰');
	assert.equal(shownCell(both, NOTE, 'note.평점', 'light').fill, PALETTE.light.fill.blue);
	assert.equal(shownCell(both, NOTE, 'note.평점', 'dark').fill, PALETTE.dark.fill.blue);
	// clearing the dark color leaves the light one
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { theme: 'dark', fill: null });
	assert.deepEqual(readTableFormat(base, '뷰').columns, { 'note.평점': { light: { fill: PALETTE.light.fill.blue } } });
});

test('a cell shows its column, then its row, then its own format', () => {
	const base = sample();
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { theme: 'light', fill: '#FBF1C7', text: '#8D6E00' });
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { bold: true });
	writeTableFormat(base, '뷰', { kind: 'row', paths: [NOTE] }, { theme: 'light', fill: '#E1F2E5' });
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.평점']] }, { theme: 'light', text: '#C0262D' });
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.평점']] }, { bold: false, align: 'right' });
	const format = readTableFormat(base, '뷰');
	assert.deepEqual(shownCell(format, NOTE, 'note.평점', 'light'), { fill: '#E1F2E5', text: '#C0262D', bold: false, italic: false, align: 'right' });
	assert.deepEqual(shownCell(format, OTHER, 'note.평점', 'light'), { fill: '#FBF1C7', text: '#8D6E00', bold: true, italic: false, align: null });
	assert.deepEqual(shownCell(format, NOTE, 'file.name', 'light'), { fill: '#E1F2E5', text: null, bold: false, italic: false, align: null });
	// a header has its own format
	assert.deepEqual(shownHeader(format, 'note.평점', 'light'), { fill: null, text: null, bold: false, italic: false, align: null });
	assert.deepEqual(formatCounts(format), { header: 0, columns: 1, rows: 1, cells: 1 });
});

test('a selection formats every cell in it', () => {
	const base = sample();
	const cells = [[NOTE, 'file.name'], [NOTE, 'note.평점'], [OTHER, 'file.name'], [OTHER, 'note.평점']];
	writeTableFormat(base, '뷰', { kind: 'cell', cells }, { theme: 'dark', fill: '#33264F' });
	const format = readTableFormat(base, '뷰');
	for (const [path, prop] of cells) assert.equal(shownCell(format, path, prop, 'dark').fill, '#33264F');
	assert.equal(formatCounts(format).cells, 4);
});

test('choices that match the layers underneath are not stored', () => {
	const base = sample();
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { theme: 'light', fill: '#FBF1C7' });
	writeTableFormat(base, '뷰', { kind: 'column', props: ['note.평점'] }, { bold: true });
	const format = readTableFormat(base, '뷰');
	// no color in one cell of a colored column: stored as `none`
	assert.deepEqual(planChange(format, 'cell', NOTE, 'note.평점', 'light', { fill: null }), { theme: 'light', fill: NO_COLOR });
	// no color on the column itself: cleared
	assert.deepEqual(planChange(format, 'column', null, 'note.평점', 'light', { fill: null }), { theme: 'light', fill: null });
	// bold in a bold column: nothing to store; not bold: stored
	assert.deepEqual(planChange(format, 'cell', NOTE, 'note.평점', 'light', { bold: true }), { bold: null });
	assert.deepEqual(planChange(format, 'cell', NOTE, 'note.평점', 'light', { bold: false }), { bold: false });
	assert.deepEqual(planChange(format, 'header', null, 'note.평점', 'light', { bold: false }), { bold: null });
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.평점']] }, planChange(format, 'cell', NOTE, 'note.평점', 'light', { fill: null }));
	assert.equal(shownCell(readTableFormat(base, '뷰'), NOTE, 'note.평점', 'light').fill, null);
	assert.equal(shownCell(readTableFormat(base, '뷰'), OTHER, 'note.평점', 'light').fill, '#FBF1C7');
});

test('clearing removes empty entries and the keys around them', () => {
	const base = sample();
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.평점']] }, { theme: 'light', fill: '#E1F2E5' });
	writeTableFormat(base, '뷰', { kind: 'header', props: ['file.name'] }, { italic: true });
	clearTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.평점']] });
	assert.deepEqual(base.views[0].achmageLook.format, { header: { 'file.name': { italic: true } } });
	writeTableFormat(base, '뷰', { kind: 'header', props: ['file.name'] }, { italic: null });
	assert.deepEqual(base.views[0].achmageLook, { shape: 'landscape', fit: 'contain' });
	// a view whose look holds only the format loses the key entirely
	writeTableFormat(base, '카드', { kind: 'column', props: ['file.name'] }, { bold: true });
	assert.deepEqual(base.views[1].achmageLook, { format: { columns: { 'file.name': { bold: true } } } });
	clearTableFormat(base, '카드', null);
	assert.equal('achmageLook' in base.views[1], false);
	assert.equal(base.views[1].myOwnKey, 'kept');
});

test('keys a later version adds inside a format are kept', () => {
	const base = sample();
	base.views[0].achmageLook.format = { header: { 'note.평점': { bold: true, size: 'large', light: { fill: '#FFFFFF', glow: '#000000' } } } };
	writeTableFormat(base, '뷰', { kind: 'header', props: ['note.평점'] }, { theme: 'light', fill: '#DCEBFB' });
	assert.deepEqual(base.views[0].achmageLook.format.header['note.평점'], { bold: true, size: 'large', light: { fill: '#DCEBFB', glow: '#000000' } });
	// and the view look keeps the format when the look itself changes
	writeViewLook(base, '뷰', { shape: null, fit: null });
	assert.deepEqual(base.views[0].achmageLook.format.header['note.평점'].bold, true);
});

test('row and cell formats follow renamed notes and folders', () => {
	const base = sample();
	writeTableFormat(base, '뷰', { kind: 'row', paths: [NOTE] }, { theme: 'light', fill: '#E1F2E5' });
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.평점'], [OTHER, 'note.평점']] }, { bold: true });
	const renamed = '01. Inbox/손끝으로 기억할게요 (AI 영화).md';
	assert.equal(renameNotePaths(base, (path) => (path === NOTE ? renamed : null)), true);
	let format = readTableFormat(base, '뷰');
	assert.deepEqual(Object.keys(format.rows), [renamed]);
	assert.deepEqual(Object.keys(format.cells).sort(), [OTHER, renamed].sort());
	// a whole folder
	const folder = (path) => (path.startsWith('01. Inbox/') ? `02. 영화/${path.slice('01. Inbox/'.length)}` : null);
	assert.equal(renameNotePaths(base, folder), true);
	format = readTableFormat(base, '뷰');
	assert.deepEqual(Object.keys(format.cells).sort(), ['02. 영화/다른 영화.md', '02. 영화/손끝으로 기억할게요 (AI 영화).md']);
	assert.equal(renameNotePaths(base, (path) => (path === 'nothing.md' ? 'else.md' : null)), false);
	// a renamed note's cells join what is left at the new path
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [['a.md', 'file.name']] }, { italic: true });
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [['b.md', 'note.평점']] }, { italic: true });
	renameNotePaths(base, (path) => (path === 'a.md' ? 'b.md' : null));
	assert.deepEqual(Object.keys(readTableFormat(base, '뷰').cells['b.md']).sort(), ['file.name', 'note.평점']);
});

test('the format survives a round trip through plain data', () => {
	const base = sample();
	writeTableFormat(base, '뷰', { kind: 'header', props: ['note.평점'] }, { theme: 'dark', text: '#8DB9F5' });
	writeTableFormat(base, '뷰', { kind: 'cell', cells: [[NOTE, 'note.로그라인(줄거리)']] }, { theme: 'light', fill: '#FCE7D6' });
	const again = copy(base);
	assert.deepEqual(readTableFormat(again, '뷰'), readTableFormat(base, '뷰'));
});

test('row heights fit the content at the lowest preset that holds it', () => {
	assert.equal(fitRowPreset(25, 30), '');
	assert.equal(fitRowPreset(30, 30), '');
	assert.equal(fitRowPreset(31, 30), 'medium');
	assert.equal(fitRowPreset(60, 30), 'medium');
	assert.equal(fitRowPreset(61, 30), 'tall');
	assert.equal(fitRowPreset(120, 30), 'tall');
	assert.equal(fitRowPreset(121, 30), 'extra');
	assert.equal(fitRowPreset(999, 30), 'extra');
	// a theme with taller rows
	assert.equal(fitRowPreset(64, 32), 'medium');
	assert.equal(fitRowPreset(65, 32), 'tall');
	assert.equal(rowPixels('tall', 30), 120);
	assert.equal(nearestRowPreset(40, 30), '');
	assert.equal(nearestRowPreset(50, 30), 'medium');
	assert.equal(nearestRowPreset(100, 30), 'tall');
	assert.equal(nearestRowPreset(500, 30), 'extra');
});

test('the narrowest fitting width is found within a few pixels', () => {
	let calls = 0;
	const width = narrowestFit(100, 1200, (w) => {
		calls++;
		return w >= 437;
	});
	assert.ok(width >= 437 && width <= 441, String(width));
	assert.ok(calls < 16, String(calls));
	assert.equal(narrowestFit(100, 1200, () => true), 100);
	assert.equal(narrowestFit(100, 1200, () => false), 1200);
	assert.equal(narrowestFit(300, 200, () => false), 300);
});

/** WCAG contrast ratio of two #RRGGBB colors. */
function contrast(a, b) {
	const luminance = (hex) => {
		const [r, g, b] = [1, 3, 5].map((i) => {
			const c = parseInt(hex.slice(i, i + 2), 16) / 255;
			return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
}

test('palette colors stay readable in their theme', () => {
	// Obsidian's default background and text colors
	const themes = { light: { background: '#FFFFFF', text: '#222222' }, dark: { background: '#1E1E1E', text: '#DADADA' } };
	for (const [theme, { background, text }] of Object.entries(themes)) {
		for (const name of PALETTE_NAMES) {
			const ink = PALETTE[theme].text[name];
			const fill = PALETTE[theme].fill[name];
			assert.ok(contrast(ink, background) >= 4.5, `${theme} text ${name} ${contrast(ink, background).toFixed(2)}`);
			assert.ok(contrast(text, fill) >= 4.5, `${theme} fill ${name} ${contrast(text, fill).toFixed(2)}`);
			assert.match(ink, /^#[0-9A-F]{6}$/);
			assert.match(fill, /^#[0-9A-F]{6}$/);
		}
	}
});
