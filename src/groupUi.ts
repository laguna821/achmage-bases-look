import { setIcon, SliderComponent, ToggleComponent, type TFile } from 'obsidian';
import { autoColors, normalizeHex, type GroupStyle } from './groups.ts';
import { strings } from './i18n';
import { visibleGroups } from './native';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

export type Queue = (job: () => Promise<BaseInfo | null>) => void;

function onActivate(el: HTMLElement, run: () => void): void {
	el.addEventListener('click', run);
	el.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			run();
		}
	});
}

/**
 * Group colors and group look controls for one base: a color per group value (swatch and
 * hex field), auto colors, and the background / border / heading switches. Used both in the
 * native Group menu and in the toolbar panel.
 */
export function renderGroupControls(
	plugin: AchmageBasesLookPlugin,
	container: HTMLElement,
	base: TFile,
	root: HTMLElement,
	info: BaseInfo,
	queue: Queue,
): void {
	const t = strings();
	const groups = visibleGroups(root);
	if (groups.length === 0) {
		container.createDiv({ cls: 'achmage-look-panel-note', text: t.groupNone });
		return;
	}

	const list = container.createDiv({ cls: 'achmage-look-groups' });
	for (const group of groups) {
		const color = info.groupColors[group] ?? null;
		const row = list.createDiv({ cls: 'achmage-look-group-row' });
		const picker = row.createEl('input', { type: 'color', cls: 'achmage-look-swatch', attr: { 'aria-label': group || t.groupEmpty } });
		picker.value = color ?? '#888888';
		picker.toggleClass('is-empty', !color);
		row.createSpan({ cls: 'achmage-look-group-name', text: group || t.groupEmpty });
		const hex = row.createEl('input', { type: 'text', cls: 'achmage-look-hex', attr: { maxlength: '7', spellcheck: 'false' } });
		hex.value = color ?? '';
		const clear = row.createDiv({ cls: ['clickable-icon', 'achmage-look-group-clear'], attr: { role: 'button', tabindex: '0', 'aria-label': t.groupClearOne } });
		setIcon(clear, 'x');
		clear.toggle(Boolean(color));
		picker.addEventListener('change', () => queue(() => plugin.setGroupColors(base, { [group]: picker.value })));
		hex.addEventListener('change', () => {
			const value = normalizeHex(hex.value);
			if (value) queue(() => plugin.setGroupColors(base, { [group]: value }));
			else if (!hex.value.trim() && color) queue(() => plugin.setGroupColors(base, { [group]: null }));
			else hex.value = color ?? '';
		});
		hex.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') hex.blur();
		});
		onActivate(clear, () => queue(() => plugin.setGroupColors(base, { [group]: null })));
	}
	const actions = container.createDiv({ cls: 'achmage-look-group-actions' });
	const auto = actions.createEl('button', { text: t.groupAuto });
	auto.addEventListener('click', () => queue(() => plugin.setGroupColors(base, autoColors(groups, info.groupColors))));
	const clearAll = actions.createEl('button', { text: t.groupClear });
	clearAll.disabled = Object.keys(info.groupColors).length === 0;
	clearAll.addEventListener('click', () => {
		const changes: Record<string, null> = {};
		for (const group of Object.keys(info.groupColors)) changes[group] = null;
		queue(() => plugin.setGroupColors(base, changes));
	});

	const style = plugin.effectiveGroupStyle(info);
	const switches = container.createDiv({ cls: 'achmage-look-switches' });
	const toggleRow = (label: string, key: keyof Pick<GroupStyle, 'background' | 'border' | 'heading'>) => {
		const row = switches.createDiv({ cls: 'achmage-look-switch-row' });
		row.createSpan({ text: label });
		new ToggleComponent(row).setValue(style[key]).onChange((value) => queue(() => plugin.setGroupStyle(base, { [key]: value })));
	};
	toggleRow(t.groupBackgroundName, 'background');
	if (style.background) {
		const row = switches.createDiv({ cls: ['achmage-look-switch-row', 'mod-slider'] });
		row.createSpan({ text: t.groupTintName });
		new SliderComponent(row).setLimits(4, 30, 1).setValue(style.tint).onChange((value) => queue(() => plugin.setGroupStyle(base, { tint: value })));
	}
	toggleRow(t.groupBorderName, 'border');
	toggleRow(t.groupHeadingName, 'heading');
	container.createDiv({ cls: 'achmage-look-panel-note', text: t.groupSavedNote });
}

/** Classes and variables on a view root that turn the group look on. */
export function applyGroupStyle(root: HTMLElement, style: GroupStyle): void {
	root.toggleClass('achmage-look-group-bg', style.background);
	root.toggleClass('achmage-look-group-border', style.border);
	root.toggleClass('achmage-look-group-heading', style.heading);
	const tint = `${style.tint}%`;
	if (root.style.getPropertyValue('--achmage-look-tint') !== tint) {
		root.setCssProps({ '--achmage-look-tint': tint, '--achmage-look-tint-soft': `${Math.max(2, Math.round(style.tint / 2))}%` });
	}
}

export function clearGroupStyle(root: HTMLElement): void {
	root.removeClasses(['achmage-look-group-bg', 'achmage-look-group-border', 'achmage-look-group-heading']);
	root.setCssProps({ '--achmage-look-tint': '', '--achmage-look-tint-soft': '' });
}
