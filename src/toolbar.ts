import { DropdownComponent, setIcon, SliderComponent, ToggleComponent, type TFile } from 'obsidian';
import { SIZE_PRESETS, type FitPreset, type RatioPreset, type ViewType } from './baseConfig.ts';
import { renderGroupControls } from './groupUi';
import { strings } from './i18n';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

export const TOOLBAR = 'achmage-look-toolbar-item';
const PANEL = 'achmage-look-panel';
const PANEL_WIDTH = 340;

type SizePreset = keyof typeof SIZE_PRESETS;

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
				void this.plugin.toggleBase(base);
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
		const queue = (job: () => Promise<BaseInfo | null>) => {
			busy = busy.then(async () => {
				const info = await job();
				if (info) render(info);
			});
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

		const renderView = (box: HTMLElement, info: BaseInfo, viewName: string) => {
			const view = info.views.find((each) => each.name === viewName);
			if (!view) {
				box.createDiv({ cls: 'achmage-look-panel-note', text: t.viewMissing });
				return;
			}
			const layouts: Record<ViewType, string> = { table: t.layoutTable, cards: t.layoutCards, list: t.layoutList, kanban: t.layoutKanban };
			new DropdownComponent(row(box, t.layout))
				.addOptions(layouts)
				.setValue(view.type)
				.onChange((type) => queue(() => this.plugin.setViewOptions(base, viewName, { type })));
			new ToggleComponent(row(box, t.viewThumbnails))
				.setValue(view.thumbnails)
				.onChange((on) => queue(() => this.plugin.setViewThumbnails(base, viewName, on)));

			if (view.type === 'kanban') {
				new SliderComponent(sliderRow(box, t.columnWidth))
					.setLimits(200, 600, 10)
					.setValue(view.columnWidth ?? 280)
					.onChange((value) => queue(() => this.plugin.setViewOptions(base, viewName, { columnWidth: value })));
			} else if (view.type === 'cards') {
				new SliderComponent(sliderRow(box, t.cardSize))
					.setLimits(100, 500, 10)
					.setValue(view.cardSize ?? 200)
					.onChange((value) => queue(() => this.plugin.setViewOptions(base, viewName, { cardSize: value })));
			} else if (view.type === 'table') {
				new DropdownComponent(row(box, t.rowHeight))
					.addOptions({ '': t.rowShort, medium: t.rowMedium, tall: t.rowTall, extra: t.rowExtra })
					.setValue(view.rowHeight)
					.onChange((rowHeight) => queue(() => this.plugin.setViewOptions(base, viewName, { rowHeight })));
			} else if (view.type === 'list') {
				new SliderComponent(sliderRow(box, t.listThumbSize))
					.setLimits(0, 100, 5)
					.setValue(this.plugin.settings.listSize)
					.onChange((value) => void this.plugin.updateSetting('listSize', value));
			}
			if ((view.type === 'kanban' || view.type === 'cards') && view.thumbnails) {
				new DropdownComponent(row(box, t.imageFit))
					.addOptions({ cover: t.fitCover, contain: t.fitContain })
					.setValue(view.imageFit)
					.onChange((fit) => queue(() => this.plugin.setViewOptions(base, viewName, { imageFit: fit === 'contain' ? 'contain' : null })));
				new SliderComponent(sliderRow(box, t.imageRatio))
					.setLimits(0.25, 2.5, 0.05)
					.setValue(view.imageAspectRatio ?? (view.type === 'kanban' ? 0.5 : 1))
					.onChange((value) => queue(() => this.plugin.setViewOptions(base, viewName, { imageAspectRatio: value })));
			}
		};

		const renderAll = (box: HTMLElement, info: BaseInfo) => {
			if (!info.enabled) {
				box.createDiv({ cls: 'achmage-look-panel-note', text: t.thumbnailsOff });
				const on = box.createEl('button', { text: t.turnOn, cls: 'mod-cta' });
				on.addEventListener('click', () => queue(async () => {
					await this.plugin.toggleBase(base);
					return this.plugin.baseInfo(base);
				}));
				return;
			}
			const look = info.look;
			const size = look.size ?? this.plugin.settings.listSize;
			label(box, t.menuSize);
			new SliderComponent(box.createDiv({ cls: 'achmage-look-panel-slider' }))
				.setLimits(0, 100, 1)
				.setValue(size)
				.onChange((value) => queue(() => this.plugin.setLook(base, { size: value })));
			const presets: [SizePreset, string][] = [['small', t.sizeSmall], ['medium', t.sizeMedium], ['large', t.sizeLarge]];
			const preset = (Object.entries(SIZE_PRESETS) as [SizePreset, number][]).find(([, value]) => value === size)?.[0] ?? null;
			chips(box, presets, preset, (value) => queue(() => this.plugin.setLook(base, { size: SIZE_PRESETS[value] })));
			box.createDiv({ cls: 'achmage-look-panel-note', text: t.sizeNote });
			label(box, t.menuShape);
			const shapes: [RatioPreset, string, boolean][] = [
				['square', '1:1', true], ['landscape', '4:3', true], ['wide', '16:9', true], ['portrait', '3:4', true], ['poster', '2:3', true],
			];
			chips(box, shapes, look.ratio, (ratio) => queue(() => this.plugin.setLook(base, { ratio })));
			label(box, t.menuFit);
			const fits: [FitPreset, string][] = [['cover', t.fitCover], ['contain', t.fitContain]];
			chips(box, fits, look.fit, (fit) => queue(() => this.plugin.setLook(base, { fit })));
		};

		const render = (info: BaseInfo) => {
			const scroll = el.scrollTop;
			body.empty();
			body.createDiv({ cls: 'achmage-look-panel-title', text: t.panelTitle });
			const viewName = root.find('.bases-toolbar-views-menu .text-button-label')?.textContent?.trim() ?? '';
			if (viewName) fold('view', t.sectionView(viewName), (box) => renderView(box, info, viewName));
			fold('all', t.sectionAll, (box) => renderAll(box, info));
			fold('groups', t.sectionGroups, (box) => renderGroupControls(this.plugin, box, base, root, info, queue));
			const footer = body.createDiv({ cls: 'achmage-look-panel-footer' });
			if (info.enabled) {
				const off = footer.createEl('button', { text: t.turnOff });
				off.addEventListener('click', () => queue(async () => {
					await this.plugin.toggleBase(base);
					return this.plugin.baseInfo(base);
				}));
			} else {
				footer.createSpan();
			}
			const all = footer.createEl('button', { text: t.allSettings });
			all.addEventListener('click', () => {
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
