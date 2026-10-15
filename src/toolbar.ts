import { ColorComponent, DropdownComponent, setIcon, SliderComponent, ToggleComponent, type TFile } from 'obsidian';
import { RATIOS, type FitPreset, type RatioPreset, type ViewType } from './baseConfig.ts';
import type { ViewLookChanges } from './viewLook.ts';
import { renderGroupControls } from './groupUi';
import { ChoiceSuggest, type Choice } from './suggest';
import { strings } from './i18n';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

export const TOOLBAR = 'achmage-look-toolbar-item';
const PANEL = 'achmage-look-panel';
const PANEL_WIDTH = 340;

/** The shape preset closest to an aspect ratio (height ÷ width), or null for a custom one. */
function presetFor(aspect: number | null | undefined): RatioPreset | null {
	if (typeof aspect !== 'number') return null;
	const found = (Object.entries(RATIOS) as [RatioPreset, number][]).find(([, value]) => Math.abs(value - aspect) <= 0.001 * Math.max(1, value));
	return found?.[0] ?? null;
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

function toolbarItem(cls: string, icon: string, label: string | null, aria: string): { item: HTMLElement; button: HTMLElement } {
	const item = createDiv({ cls: ['bases-toolbar-item', TOOLBAR, cls] });
	const button = item.createDiv({ cls: ['text-icon-button', 'tappable'], attr: { tabindex: '0', role: 'button', 'aria-label': aria } });
	setIcon(button.createSpan({ cls: 'text-button-icon' }), icon);
	if (label) button.createSpan({ cls: 'text-button-label', text: label });
	return { item, button };
}

/**
 * Two buttons in the Bases toolbar, before Sort: a small sliders button that opens the look
 * panel (thumbnail size, shape, fit and group colors), and “Thumbnails”, which turns
 * thumbnails on or off in one click.
 */
export class ToolbarControls {
	private readonly plugin: AchmageBasesLookPlugin;
	private panel: { el: HTMLElement; button: HTMLElement; close: () => void } | null = null;

	constructor(plugin: AchmageBasesLookPlugin) {
		this.plugin = plugin;
	}

	ensure(root: HTMLElement, base: TFile, enabled: boolean): void {
		const toolbar = root.find('.bases-toolbar');
		if (!toolbar) return;
		const t = strings();
		let gear = toolbar.find(`.${TOOLBAR}.mod-panel`);
		let toggle = toolbar.find(`.${TOOLBAR}.mod-toggle`);
		if (!gear || !toggle || gear.dataset.path !== base.path) {
			toolbar.findAll(`.${TOOLBAR}`).forEach((el) => el.detach());
			const panelButton = toolbarItem('mod-panel', 'sliders-horizontal', null, t.panelButton);
			const toggleButton = toolbarItem('mod-toggle', 'image', t.toolbarLabel, t.toggleOn);
			gear = panelButton.item;
			toggle = toggleButton.item;
			gear.dataset.path = base.path;
			onActivate(panelButton.button, () => this.togglePanel(panelButton.button, base, root));
			onActivate(toggleButton.button, () => {
				this.close();
				const viewName = root.find('.bases-toolbar-views-menu .text-button-label')?.textContent?.trim();
				// The button belongs to the view on screen; the whole base is a choice in the panel.
				if (viewName) void this.plugin.toggleView(base, viewName);
			});
			const anchor = toolbar.find('.bases-toolbar-sort-menu');
			const parent = anchor?.parentElement ?? toolbar;
			parent.insertBefore(gear, anchor);
			parent.insertBefore(toggle, anchor);
		}
		toggle.toggleClass('is-active', enabled);
		toggle.find('.text-icon-button')?.setAttribute('aria-label', enabled ? t.toggleOff : t.toggleOn);
	}

	remove(root: HTMLElement): void {
		root.findAll(`.${TOOLBAR}`).forEach((el) => el.detach());
	}

	close(): void {
		this.panel?.close();
	}

	/** Open the panel from the command palette, under the sliders button (or the toolbar). */
	openPanel(root: HTMLElement, base: TFile): void {
		const anchor = root.find(`.${TOOLBAR}.mod-panel .text-icon-button`) ?? root.find('.bases-toolbar');
		if (!anchor) return;
		this.close();
		this.open(anchor, base, root);
	}

	private togglePanel(button: HTMLElement, base: TFile, root: HTMLElement): void {
		// Open unless this same button's panel is showing (it may have been removed from the page meanwhile).
		const showingHere = this.panel?.button === button && this.panel.el.isConnected;
		this.close();
		if (!showingHere) this.open(button, base, root);
	}

	/**
	 * The look panel: one place for this view's own settings, thumbnails for every view and the
	 * group look. Each section folds; the panel never runs past the bottom of the window and
	 * scrolls inside instead.
	 */
	private open(button: HTMLElement, base: TFile, root: HTMLElement): void {
		const t = strings();
		const doc = button.doc;
		const el = doc.body.createDiv({ cls: PANEL, attr: { role: 'dialog', 'aria-label': t.panelTitle } });
		const body = el.createDiv({ cls: 'achmage-look-panel-body' });
		let busy = Promise.resolve();
		const queue = (job: () => Promise<BaseInfo | null>, settle = false) => {
			busy = busy.then(async () => {
				const info = await job();
				if (info) render(info);
				if (settle) {
					window.setTimeout(() => {
						if (el.isConnected) render(this.plugin.baseInfo(base) ?? info ?? this.plugin.emptyBaseInfo());
					}, 700);
				}
			}).catch(() => undefined);
		};

		const fold = (id: string, title: string, build: (box: HTMLElement) => void) => {
			const wrap = body.createDiv({ cls: 'achmage-look-fold' });
			const collapsed = this.plugin.settings.panelCollapsed.includes(id);
			wrap.toggleClass('is-collapsed', collapsed);
			const head = wrap.createDiv({ cls: 'achmage-look-fold-head', attr: { role: 'button', tabindex: '0', 'aria-expanded': String(!collapsed) } });
			setIcon(head.createSpan({ cls: 'achmage-look-fold-icon' }), 'chevron-down');
			head.createSpan({ cls: 'achmage-look-fold-title', text: title });
			const content = wrap.createDiv({ cls: 'achmage-look-fold-body' });
			build(content);
			onActivate(head, () => {
				const nowCollapsed = !wrap.hasClass('is-collapsed');
				wrap.toggleClass('is-collapsed', nowCollapsed);
				head.setAttribute('aria-expanded', String(!nowCollapsed));
				const others = this.plugin.settings.panelCollapsed.filter((each) => each !== id);
				void this.plugin.updateSetting('panelCollapsed', nowCollapsed ? [...others, id] : others);
			});
		};
		const label = (box: HTMLElement, title: string) => box.createDiv({ cls: 'achmage-look-panel-label', text: title });
		const row = (box: HTMLElement, title: string) => {
			const line = box.createDiv({ cls: 'achmage-look-switch-row' });
			line.createSpan({ text: title });
			return line;
		};
		const chips = <T extends string>(box: HTMLElement, options: [T, string, boolean?][], current: string | null, pick: (value: T) => void) => {
			const line = box.createDiv({ cls: 'achmage-look-chips' });
			for (const [value, text, withShape] of options) {
				const chip = line.createEl('button', { cls: 'achmage-look-chip', attr: { 'data-value': value } });
				if (withShape) chip.createSpan({ cls: ['achmage-look-shape', `mod-${value}`] });
				chip.createSpan({ text });
				chip.toggleClass('is-active', value === current);
				chip.addEventListener('click', () => pick(value));
			}
		};

		const sliderRow = (box: HTMLElement, title: string) => {
			const line = row(box, title);
			line.addClass('mod-slider');
			return line;
		};

		/** Settings of the view on screen only: each view of a base keeps its own look. */
		const renderView = (box: HTMLElement, info: BaseInfo, viewName: string) => {
			const view = info.views.find((each) => each.name === viewName);
			if (!view) {
				box.createDiv({ cls: 'achmage-look-panel-note', text: t.viewMissing });
				return;
			}
			const look = this.plugin.viewLookOf(info, viewName);
			const cover = view.type === 'kanban' || view.type === 'cards';
			const setLook = (changes: ViewLookChanges) => queue(() => this.plugin.setViewLook(base, viewName, changes));
			const setNative = (changes: Record<string, unknown>) => queue(() => this.plugin.setViewOptions(base, viewName, changes));

			const layouts: Record<ViewType, string> = { table: t.layoutTable, cards: t.layoutCards, list: t.layoutList, kanban: t.layoutKanban };
			new DropdownComponent(row(box, t.layout))
				.addOptions(layouts)
				.setValue(view.type)
				.onChange((type) => setNative({ type }));
			new ToggleComponent(row(box, t.viewThumbnails))
				.setValue(view.thumbnails)
				.onChange((on) => queue(() => this.plugin.setViewThumbnails(base, viewName, on)));

			// Size: Obsidian's own setting of this view, or the list thumbnail size of this view.
			if (view.type === 'kanban') {
				new SliderComponent(sliderRow(box, t.columnWidth))
					.setLimits(200, 600, 10)
					.setValue(view.columnWidth ?? 280)
					.onChange((value) => setNative({ columnWidth: value }));
			} else if (view.type === 'cards') {
				new SliderComponent(sliderRow(box, t.cardSize))
					.setLimits(100, 500, 10)
					.setValue(view.cardSize ?? 200)
					.onChange((value) => setNative({ cardSize: value }));
			} else if (view.type === 'table') {
				new DropdownComponent(row(box, t.rowHeight))
					.addOptions({ '': t.rowShort, medium: t.rowMedium, tall: t.rowTall, extra: t.rowExtra })
					.setValue(view.rowHeight)
					.onChange((rowHeight) => setNative({ rowHeight }));
			} else if (view.type === 'list') {
				new SliderComponent(sliderRow(box, t.listThumbSize))
					.setLimits(0, 100, 5)
					.setValue(look.listSize)
					.onChange((value) => setLook({ listSize: value }));
			}

			if (view.thumbnails) {
				const shapes: [RatioPreset, string, boolean][] = [
					['square', '1:1', true], ['landscape', '4:3', true], ['wide', '16:9', true], ['portrait', '3:4', true], ['poster', '2:3', true],
				];
				const aspect = cover ? view.imageAspectRatio : (info.aspects[viewName] ?? null);
				const currentShape = (cover ? null : look.shape) ?? presetFor(aspect);
				label(box, t.menuShape);
				chips(box, shapes, currentShape, (ratio) => (cover ? setNative({ imageAspectRatio: RATIOS[ratio] }) : setLook({ shape: ratio })));
				if (cover) {
					new SliderComponent(sliderRow(box, t.imageRatio))
						.setLimits(0.25, 2.5, 0.05)
						.setValue(view.imageAspectRatio ?? (view.type === 'kanban' ? 0.5 : 1))
						.onChange((value) => setNative({ imageAspectRatio: value }));
				}
				label(box, t.menuFit);
				const fits: [FitPreset, string][] = [['cover', t.fitCover], ['contain', t.fitContain]];
				chips(box, fits, cover ? view.imageFit : look.fit, (fit) => (cover ? setNative({ imageFit: fit === 'contain' ? 'contain' : null }) : setLook({ fit })));
			}

			label(box, t.viewDisplay);
			new ToggleComponent(row(box, t.placeholdersName))
				.setValue(look.placeholders)
				.onChange((value) => setLook({ placeholders: value }));
			if (!cover) {
				new ToggleComponent(row(box, t.tidyName))
					.setValue(look.tidy)
					.onChange((value) => setLook({ tidy: value }));
			}
			if (cover) {
				new ToggleComponent(row(box, t.hoverLiftName))
					.setValue(look.hoverLift)
					.onChange((value) => setLook({ hoverLift: value }));
			} else {
				new ToggleComponent(row(box, t.hoverRowsName))
					.setValue(look.hoverRows)
					.onChange((value) => setLook({ hoverRows: value }));
			}
			if (cover ? look.hoverLift : look.hoverRows) {
				new ToggleComponent(row(box, t.hoverAccentName))
					.setValue(look.hoverColor === null)
					.onChange((accent) => setLook({ hoverColor: accent ? null : '#0090FF' }));
				if (look.hoverColor !== null) {
					new ColorComponent(row(box, t.hoverColorName))
						.setValue(look.hoverColor)
						.onChange((color) => setLook({ hoverColor: color }));
				}
			}
			box.createDiv({ cls: 'achmage-look-panel-note', text: t.viewSavedNote });
		};

		/**
		 * This base's own settings. Each field shows what the base uses now; typing searches the
		 * properties (or folders) its notes use, and the choice is stored in this base only.
		 */
		const renderBase = (box: HTMLElement, info: BaseInfo) => {
			const s = info.settings;
			const stats = this.plugin.basePropertyStats(root);
			const ranked = (key: 'images' | 'links' | 'notes', describe: (notes: number, count: number) => string, extra: string[]): Choice[] => {
				const entries = [...stats.entries()].sort((a, b) => b[1][key] - a[1][key] || b[1].notes - a[1].notes || a[0].localeCompare(b[0]));
				const choices: Choice[] = entries.map(([name, entry]) => ({ value: name, note: describe(entry.notes, entry[key]) }));
				for (const name of extra) if (name && !stats.has(name)) choices.push({ value: name, note: t.choiceUnused });
				return choices;
			};
			const field = (title: string, value: string, hint: string, choices: () => Choice[], commit: (value: string | null) => void) => {
				const wrap = box.createDiv({ cls: 'achmage-look-base-field' });
				wrap.createDiv({ cls: 'achmage-look-panel-label', text: title });
				const input = wrap.createEl('input', { type: 'text', attr: { spellcheck: 'false', 'aria-label': title } });
				input.value = value;
				wrap.createDiv({ cls: 'achmage-look-panel-note', text: hint });
				// Typing only searches. A value is applied when a suggestion is picked or Enter is
				// pressed; Escape or leaving the field puts the current value back, so a half-typed
				// search never changes the base.
				let last = value;
				const save = (next: string) => {
					const clean = next.trim();
					input.value = clean || last;
					if (clean === last) return;
					last = clean;
					commit(clean || null);
				};
				new ChoiceSuggest(this.plugin.app, input, choices, save);
				input.addEventListener('keydown', (event) => {
					if (event.key === 'Enter' && !event.isComposing) {
						event.preventDefault();
						save(input.value);
						input.blur();
					} else if (event.key === 'Escape') {
						input.value = last;
					}
				});
				input.addEventListener('blur', () => {
					window.setTimeout(() => {
						if (!input.matches(':focus')) input.value = last;
					}, 150);
				});
			};
			const stored = (key: keyof typeof s.stored) => (s.stored[key] !== undefined ? t.sourceBase : t.sourceDefault);
			const sourceHint = s.thumbnailSource === 'base' ? t.sourceBase : s.thumbnailSource === 'detected' ? t.sourceDetected : t.sourceDefault;
			field(t.baseThumbnailProperty, s.thumbnailProperty, `${sourceHint}${s.external ? ` ${t.sourceExternal}` : ''}`,
				() => ranked('images', t.choiceImages, [this.plugin.settings.property]),
				(value) => queue(() => this.plugin.setBaseSettings(base, { thumbnailProperty: value })));
			field(t.baseLinkProperty, s.linkProperty, stored('linkProperty'),
				() => ranked('links', t.choiceLinks, [this.plugin.settings.linkProperty]),
				(value) => queue(() => this.plugin.setBaseSettings(base, { linkProperty: value })));
			field(t.baseImageFolder, s.imageFolder, s.stored.imageFolder !== undefined ? t.sourceBase : t.sourceDefaultFolder,
				() => this.plugin.app.vault.getAllFolders(false).map((folder) => ({ value: folder.path, note: '' })),
				(value) => queue(() => this.plugin.setBaseSettings(base, { imageFolder: value })));

			label(box, t.baseSaving);
			new DropdownComponent(row(box, t.defaultStorageName))
				.addOptions({ vault: t.storeVault, r2: t.storeR2 })
				.setValue(s.defaultStorage)
				.onChange((value) => queue(() => this.plugin.setBaseSettings(base, { defaultStorage: value === 'r2' ? 'r2' : 'vault' })));
			new ToggleComponent(row(box, t.askName))
				.setValue(s.askStorage)
				.onChange((value) => queue(() => this.plugin.setBaseSettings(base, { askStorage: value })));
			new ToggleComponent(row(box, t.keepCopyName))
				.setValue(s.keepVaultCopy)
				.onChange((value) => queue(() => this.plugin.setBaseSettings(base, { keepVaultCopy: value })));

			label(box, t.baseKanban);
			const kanban = s.stored.autoKanbanGroup === undefined ? '' : s.stored.autoKanbanGroup ? 'on' : 'off';
			new DropdownComponent(row(box, t.baseAutoKanban))
				.addOptions({ '': t.followDefault(this.plugin.settings.autoKanbanGroup ? t.optionOn : t.optionOff), on: t.optionOn, off: t.optionOff })
				.setValue(kanban)
				.onChange((choice) => queue(() => this.plugin.setBaseSettings(base, { autoKanbanGroup: choice === '' ? null : choice === 'on' })));
			field(t.kanbanPropertyName, s.kanbanGroupProperty, stored('kanbanGroupProperty'),
				() => ranked('notes', t.choiceNotes, [this.plugin.settings.kanbanGroupProperty]),
				(value) => queue(() => this.plugin.setBaseSettings(base, { kanbanGroupProperty: value })));

			label(box, t.baseAllViews);
			const all = box.createDiv({ cls: 'achmage-look-group-actions' });
			const on = all.createEl('button', { text: t.baseAllOn });
			on.addEventListener('click', () => queue(() => this.plugin.setAllViews(base, true)));
			const off = all.createEl('button', { text: t.baseAllOff });
			off.disabled = !info.enabled;
			off.addEventListener('click', () => queue(() => this.plugin.setAllViews(base, false)));

			if (Object.keys(s.stored).length > 0) {
				const reset = box.createEl('button', { text: t.baseReset, cls: 'achmage-look-base-reset' });
				reset.addEventListener('click', () => queue(() => this.plugin.setBaseSettings(base, {
					thumbnailProperty: null, linkProperty: null, imageFolder: null, autoKanbanGroup: null,
					kanbanGroupProperty: null, defaultStorage: null, askStorage: null, keepVaultCopy: null,
				})));
			}
		};

		const render = (info: BaseInfo) => {
			const scroll = el.scrollTop;
			body.empty();
			body.createDiv({ cls: 'achmage-look-panel-title', text: t.panelTitle });
			const viewName = root.find('.bases-toolbar-views-menu .text-button-label')?.textContent?.trim() ?? '';
			if (viewName) fold('view', t.sectionView(viewName), (box) => renderView(box, info, viewName));
			fold('base', t.sectionBase, (box) => renderBase(box, info));
			fold('groups', t.sectionGroups, (box) => renderGroupControls(this.plugin, box, base, root, info, queue, viewName || null));
			const footer = body.createDiv({ cls: 'achmage-look-panel-footer' });
			footer.createSpan();
			const connections = footer.createEl('button', { text: t.allSettings });
			connections.addEventListener('click', () => {
				close();
				this.plugin.openSettings();
			});
			el.scrollTop = scroll;
		};

		render(this.plugin.baseInfo(base) ?? this.plugin.emptyBaseInfo());

		// Keep the whole panel inside the window: below the button, and no taller than the space left.
		const rect = button.getBoundingClientRect();
		const view = doc.documentElement;
		const top = rect.bottom + 6;
		const left = Math.max(8, Math.min(rect.left, view.clientWidth - PANEL_WIDTH - 8));
		el.setCssStyles({ top: `${top}px`, left: `${left}px`, maxHeight: `${Math.max(240, view.clientHeight - top - 12)}px` });

		const onPointer = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && (el.contains(target) || button.contains(target))) return;
			// Native dropdown lists render outside the panel; keep the panel open for them.
			if (target instanceof Element && target.closest('.menu, .suggestion-container')) return;
			close();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			// Escape first closes an open suggestion list, not the panel.
			if (doc.querySelector('.suggestion-container')) return;
			event.stopPropagation();
			close();
			button.focus();
		};
		doc.addEventListener('pointerdown', onPointer, true);
		doc.addEventListener('keydown', onKey, true);
		button.addClass('is-active');
		const close = () => {
			doc.removeEventListener('pointerdown', onPointer, true);
			doc.removeEventListener('keydown', onKey, true);
			button.removeClass('is-active');
			el.detach();
			if (this.panel?.el === el) this.panel = null;
		};
		this.panel = { el, button, close };
	}
}
