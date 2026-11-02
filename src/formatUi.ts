import { ColorComponent, setIcon, type TFile } from 'obsidian';
import { strings } from './i18n';
import { openFloating, type Floating } from './floating';
import {
	ALIGNS, emptyFormat, hasFormat, PALETTE, PALETTE_NAMES, planChange, shownCell, shownHeader, THEMES,
	type Align, type FormatChange, type FormatTarget, type Theme,
} from './tableFormat.ts';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

/** One choice of what the window formats: a header, a column, rows, cells. */
export interface FormatScope {
	label: string;
	target: FormatTarget;
}

export interface FormatRequest {
	base: TFile;
	viewName: string;
	/** The view the window belongs to: its window and its theme. */
	root: HTMLElement;
	scopes: FormatScope[];
	/** The cell the window was opened on: its note (null on a header) and its column. */
	path: string | null;
	prop: string;
}

const WIDTH = 320;
const ALIGN_ICONS: Record<Align, string> = { left: 'align-left', center: 'align-center', right: 'align-right' };

let current: Floating | null = null;

export function closeFormatPanel(): void {
	current?.close();
}

const colorChoice = (key: 'text' | 'fill', value: string | null): FormatChange => (key === 'text' ? { text: value } : { fill: value });

/**
 * The format window: text and fill colors for each theme, bold, italic and alignment, for the
 * scope picked at its top. Every choice is saved in the base at once.
 */
export function openFormatPanel(plugin: AchmageBasesLookPlugin, request: FormatRequest, at: { x: number; y: number }): void {
	current?.close();
	const t = strings();
	const doc = request.root.doc;
	const onScreen: Theme = doc.body.hasClass('theme-dark') ? 'dark' : 'light';
	let theme = onScreen;
	let scope = 0;
	let info: BaseInfo = plugin.baseInfo(request.base) ?? plugin.emptyBaseInfo();

	const panel = openFloating({
		doc, cls: 'achmage-look-format', label: t.formatTitle, width: WIDTH, point: at,
		onClose: () => {
			if (current === panel) current = null;
		},
	});
	current = panel;
	const el = panel.el;

	let busy = Promise.resolve();
	const save = (job: () => Promise<BaseInfo | null>) => {
		busy = busy.then(async () => {
			const next = await job();
			if (next) info = next;
			if (el.isConnected) render();
		}).catch(() => undefined);
	};

	const render = () => {
		const format = info.formats[request.viewName] ?? emptyFormat();
		const chosen = request.scopes[scope] ?? request.scopes[0];
		if (!chosen) return;
		const layer = chosen.target.kind;
		const shown = request.path === null ? shownHeader(format, request.prop, theme) : shownCell(format, request.path, request.prop, theme);
		const choose = (choice: FormatChange) => save(() => plugin.setTableFormat(request.base, request.viewName, chosen.target,
			planChange(format, layer, request.path, request.prop, theme, choice)));

		el.empty();
		el.setAttr('data-preview', theme);
		if (request.scopes.length > 1) {
			const chips = el.createDiv({ cls: 'achmage-look-chips' });
			request.scopes.forEach((each, i) => {
				const chip = chips.createEl('button', { cls: 'achmage-look-chip', text: each.label });
				chip.toggleClass('is-active', i === scope);
				chip.addEventListener('click', () => {
					scope = i;
					render();
				});
			});
		} else {
			el.createDiv({ cls: 'achmage-look-panel-title', text: chosen.label });
		}

		const tabs = el.createDiv({ cls: ['achmage-look-segments', 'achmage-look-format-themes'] });
		for (const each of THEMES) {
			const tab = tabs.createEl('button');
			setIcon(tab.createSpan({ cls: 'achmage-look-format-theme-icon' }), each === 'dark' ? 'moon' : 'sun');
			tab.createSpan({ text: each === 'dark' ? t.themeDark : t.themeLight });
			tab.toggleClass('is-active', each === theme);
			tab.addEventListener('click', () => {
				theme = each;
				render();
			});
		}
		el.createDiv({ cls: 'achmage-look-panel-note', text: t.themeNote(theme === 'dark', theme === onScreen) });

		const swatches = (title: string, key: 'text' | 'fill') => {
			el.createDiv({ cls: 'achmage-look-panel-label', text: title });
			const row = el.createDiv({ cls: 'achmage-look-format-swatches' });
			const value = shown[key];
			const none = row.createEl('button', { cls: ['achmage-look-format-swatch', 'mod-none'], attr: { 'aria-label': t.colorNone } });
			none.toggleClass('is-active', value === null);
			none.addEventListener('click', () => choose(colorChoice(key, null)));
			for (const name of PALETTE_NAMES) {
				const color = PALETTE[theme][key][name];
				const swatch = row.createEl('button', { cls: ['achmage-look-format-swatch', `mod-${key}`], attr: { 'aria-label': t.colorNames[name] } });
				if (key === 'text') swatch.setText('A');
				swatch.setCssProps({ '--achmage-look-swatch': color });
				swatch.toggleClass('is-active', value === color);
				swatch.addEventListener('click', () => choose(colorChoice(key, color)));
			}
			const own = row.createDiv({ cls: 'achmage-look-format-custom', attr: { 'aria-label': t.colorCustom } });
			own.toggleClass('is-active', value !== null && !PALETTE_NAMES.some((name) => PALETTE[theme][key][name] === value));
			// The picker reports a color once it closes; setValue comes first so it reports nothing here.
			new ColorComponent(own).setValue(value ?? (key === 'text' ? '#888888' : '#CCCCCC')).onChange((color) => choose(colorChoice(key, color)));
		};
		swatches(t.textColor, 'text');
		swatches(t.fillColor, 'fill');

		el.createDiv({ cls: 'achmage-look-panel-label', text: t.textStyle });
		const styles = el.createDiv({ cls: 'achmage-look-format-styles' });
		const toggle = (icon: string, label: string, active: boolean, run: () => void) => {
			const button = styles.createEl('button', { cls: 'achmage-look-format-style', attr: { 'aria-label': label } });
			setIcon(button, icon);
			button.toggleClass('is-active', active);
			button.addEventListener('click', run);
		};
		toggle('bold', t.boldName, shown.bold, () => choose({ bold: !shown.bold }));
		toggle('italic', t.italicName, shown.italic, () => choose({ italic: !shown.italic }));
		styles.createSpan({ cls: 'achmage-look-format-gap' });
		for (const align of ALIGNS) {
			toggle(ALIGN_ICONS[align], t.alignNames[align], shown.align === align, () => choose({ align: shown.align === align ? null : align }));
		}

		const footer = el.createDiv({ cls: 'achmage-look-format-footer' });
		const clear = footer.createEl('button', { text: t.clearFormat });
		clear.disabled = !hasFormat(format, chosen.target);
		clear.addEventListener('click', () => save(() => plugin.clearTableFormat(request.base, request.viewName, chosen.target)));
	};

	render();
	panel.place();
}
