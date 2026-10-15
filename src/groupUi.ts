import { Scope, setIcon, SliderComponent, ToggleComponent, type TFile } from 'obsidian';
import { autoColors, groupNoteProperty, normalizeHex, type GroupStyle } from './groups.ts';
import { strings } from './i18n';
import { visibleGroups } from './native';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

/**
 * Runs base changes one after another and redraws with the result. `settle` redraws once more
 * after Bases has redrawn the view, for changes that add or remove groups.
 */
export type Queue = (job: () => Promise<BaseInfo | null>, settle?: boolean) => void;

interface EditOptions {
	value: string;
	placeholder?: string;
	/** Line under the field for the value typed so far. */
	hint: (value: string) => string;
	apply: (value: string) => void;
	/** Runs when the field closes, applied or not. */
	done?: () => void;
}

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
	viewName: string | null,
): void {
	const t = strings();
	const groups = visibleGroups(root);
	if (groups.length === 0) {
		container.createDiv({ cls: 'achmage-look-panel-note', text: t.groupNone });
		return;
	}
	const view = info.views.find((each) => each.name === viewName) ?? null;
	const property = view?.groupBy ?? null;
	const propertyName = property ? groupNoteProperty(property) : null;

	const list = container.createDiv({ cls: 'achmage-look-groups' });
	// The group without a value shows Obsidian's own label (“None”), which is not a value. Groups
	// without notes are not in the view's data either, but they are in its group order.
	const files = plugin.groupFiles(root);
	const ordered = view?.groupOrder ?? [];
	const isNoValue = (group: string) => group === '' || Boolean(files && files.has('') && !files.has(group) && !ordered.includes(group));

	/** Swap a row's label for a text field with apply and cancel buttons, and a hint line under it. */
	const editInRow = (row: HTMLElement, options: EditOptions) => {
		row.addClass('is-editing');
		const input = row.createEl('input', { type: 'text', cls: 'achmage-look-group-input', attr: { spellcheck: 'false', placeholder: options.placeholder ?? '' } });
		input.value = options.value;
		const apply = row.createDiv({ cls: ['clickable-icon', 'achmage-look-group-apply'], attr: { role: 'button', tabindex: '0', 'aria-label': t.groupApply } });
		setIcon(apply, 'check');
		const cancel = row.createDiv({ cls: ['clickable-icon', 'achmage-look-group-cancel'], attr: { role: 'button', tabindex: '0', 'aria-label': t.groupCancel } });
		setIcon(cancel, 'x');
		const hint = createDiv({ cls: 'achmage-look-group-hint' });
		row.after(hint);
		const update = () => {
			const value = input.value.trim();
			hint.setText(options.hint(value));
			apply.toggleClass('is-disabled', !value || value === options.value);
		};
		// Inside the native Group menu the menu's own keys (Enter, Escape, arrows) would take the
		// typing; like Obsidian's own "Add group" field, let keys reach the field while it is open.
		const scope = new Scope(plugin.app.scope);
		scope.register(null, null, () => true);
		plugin.app.keymap.pushScope(scope);
		let open = true;
		const finish = () => {
			if (!open) return;
			open = false;
			plugin.app.keymap.popScope(scope);
			[input, apply, cancel, hint].forEach((el) => el.detach());
			row.removeClass('is-editing');
			options.done?.();
		};
		const commit = () => {
			const value = input.value.trim();
			finish();
			if (value && value !== options.value) options.apply(value);
		};
		input.addEventListener('input', update);
		input.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter') {
				event.preventDefault();
				commit();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				finish();
			}
		});
		onActivate(apply, commit);
		onActivate(cancel, finish);
		// Clicking elsewhere (or the menu closing) cancels, as in Obsidian's own fields.
		row.addEventListener('focusout', (event) => {
			const next = event.relatedTarget;
			if (!(next instanceof Node && row.contains(next))) window.setTimeout(() => {
				if (!row.contains(activeDocument.activeElement)) finish();
			}, 0);
		});
		update();
		input.focus();
		input.select();
	};

	for (const group of groups) {
		const color = info.groupColors[group] ?? null;
		const row = list.createDiv({ cls: 'achmage-look-group-row' });
		const picker = row.createEl('input', { type: 'color', cls: 'achmage-look-swatch', attr: { 'aria-label': group || t.groupEmpty } });
		picker.value = color ?? '#888888';
		picker.toggleClass('is-empty', !color);
		row.createSpan({ cls: 'achmage-look-group-name', text: group || t.groupEmpty });
		// Renaming writes the note property; groups by a file property or formula cannot be renamed.
		if (!isNoValue(group) && viewName && property && propertyName) {
			const edit = row.createDiv({ cls: ['clickable-icon', 'achmage-look-group-edit'], attr: { role: 'button', tabindex: '0', 'aria-label': t.groupRename } });
			setIcon(edit, 'pencil');
			onActivate(edit, () => {
				if (row.hasClass('is-editing')) return;
				const count = plugin.groupFiles(root)?.get(group)?.length ?? 0;
				editInRow(row, {
					value: group,
					hint: (value) => [t.groupRenameHint(count, propertyName), value !== group && groups.includes(value) ? t.groupRenameMerge(value) : ''].filter(Boolean).join(' '),
					apply: (value) => queue(() => plugin.renameGroup(base, root, property, group, value), true),
				});
			});
		}
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
	// In the Group menu of a view with groups in manual order, Obsidian shows its own "Add group".
	const nativeAdd = container.closest<HTMLElement>('.bases-group-page')?.querySelector<HTMLElement>('.bases-group-list-container');
	const hasNativeAdd = Boolean(nativeAdd && nativeAdd.style.display !== 'none' && view?.groupsOrdered);
	if (viewName && property && propertyName && !hasNativeAdd) {
		const add = list.createDiv({ cls: 'achmage-look-group-add', attr: { role: 'button', tabindex: '0' } });
		setIcon(add.createSpan({ cls: 'achmage-look-group-add-icon' }), 'plus');
		add.createSpan({ text: t.groupAdd });
		onActivate(add, () => {
			if (list.find('.achmage-look-group-row.mod-new')) return;
			add.hide();
			const row = createDiv({ cls: ['achmage-look-group-row', 'mod-new'] });
			add.before(row);
			setIcon(row.createDiv({ cls: 'achmage-look-swatch-new' }), 'plus');
			editInRow(row, {
				value: '',
				placeholder: t.groupAddPlaceholder,
				hint: (value) => (value && groups.includes(value) ? t.groupAddExists(value) : view?.groupsOrdered ? t.groupAddHintOrdered : t.groupAddHint),
				apply: (value) => queue(() => plugin.addGroup(base, root, viewName, value), true),
				done: () => {
					row.detach();
					add.show();
				},
			});
		});
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

	container.createDiv({ cls: 'achmage-look-panel-note', text: t.groupColorsNote });

	// Background, border and heading are part of each view's look; colors above are shared.
	if (!viewName) return;
	const lookView = viewName;
	const style = plugin.viewLookOf(info, lookView).groupStyle;
	container.createDiv({ cls: 'achmage-look-panel-label', text: t.groupStyleOfView(lookView) });
	const switches = container.createDiv({ cls: 'achmage-look-switches' });
	const toggleRow = (label: string, key: keyof Pick<GroupStyle, 'background' | 'border' | 'heading'>) => {
		const row = switches.createDiv({ cls: 'achmage-look-switch-row' });
		row.createSpan({ text: label });
		new ToggleComponent(row).setValue(style[key]).onChange((value) => queue(() => plugin.setGroupStyle(base, lookView, { [key]: value })));
	};
	toggleRow(t.groupBackgroundName, 'background');
	if (style.background) {
		const row = switches.createDiv({ cls: ['achmage-look-switch-row', 'mod-slider'] });
		row.createSpan({ text: t.groupTintName });
		new SliderComponent(row).setLimits(4, 30, 1).setValue(style.tint).onChange((value) => queue(() => plugin.setGroupStyle(base, lookView, { tint: value })));
	}
	toggleRow(t.groupBorderName, 'border');
	toggleRow(t.groupHeadingName, 'heading');
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
