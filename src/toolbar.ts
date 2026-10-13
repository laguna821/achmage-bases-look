import { setIcon, SliderComponent, type TFile } from 'obsidian';
import { SIZE_PRESETS, type FitPreset, type RatioPreset } from './baseConfig.ts';
import { renderGroupControls } from './groupUi';
import { strings } from './i18n';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

export const TOOLBAR = 'achmage-look-toolbar-item';
const PANEL = 'achmage-look-panel';
const PANEL_WIDTH = 320;

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
		const reopen = this.panel?.button !== button;
		this.close();
		if (reopen) this.open(button, base, root);
	}

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

		const section = (title: string): HTMLElement => {
			const box = body.createDiv({ cls: 'achmage-look-panel-section' });
			box.createDiv({ cls: 'achmage-look-panel-label', text: title });
			return box;
		};
		const chips = <T extends string>(box: HTMLElement, options: [T, string, boolean?][], current: string | null, pick: (value: T) => void) => {
			const row = box.createDiv({ cls: 'achmage-look-chips' });
			for (const [value, label, withShape] of options) {
				const chip = row.createEl('button', { cls: 'achmage-look-chip', attr: { 'data-value': value } });
				if (withShape) chip.createSpan({ cls: ['achmage-look-shape', `mod-${value}`] });
				chip.createSpan({ text: label });
				chip.toggleClass('is-active', value === current);
				chip.addEventListener('click', () => pick(value));
			}
		};

		const renderThumbnails = (info: BaseInfo) => {
			if (!info.enabled) {
				const box = section(t.toolbarLabel);
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
			const sizeBox = section(t.menuSize);
			const slider = new SliderComponent(sizeBox.createDiv({ cls: 'achmage-look-panel-slider' }))
				.setLimits(0, 100, 1)
				.setValue(size);
			slider.onChange((value) => queue(() => this.plugin.setLook(base, { size: value })));
			const presets: [SizePreset, string][] = [['small', t.sizeSmall], ['medium', t.sizeMedium], ['large', t.sizeLarge]];
			const preset = (Object.entries(SIZE_PRESETS) as [SizePreset, number][]).find(([, value]) => value === size)?.[0] ?? null;
			chips(sizeBox, presets, preset, (value) => queue(() => this.plugin.setLook(base, { size: SIZE_PRESETS[value] })));
			sizeBox.createDiv({ cls: 'achmage-look-panel-note', text: t.sizeNote });

			const shapes: [RatioPreset, string, boolean][] = [
				['square', '1:1', true], ['landscape', '4:3', true], ['wide', '16:9', true], ['portrait', '3:4', true], ['poster', '2:3', true],
			];
			chips(section(t.menuShape), shapes, look.ratio, (ratio) => queue(() => this.plugin.setLook(base, { ratio })));
			const fits: [FitPreset, string][] = [['cover', t.fitCover], ['contain', t.fitContain]];
			chips(section(t.menuFit), fits, look.fit, (fit) => queue(() => this.plugin.setLook(base, { fit })));
		};

		const renderGroups = (info: BaseInfo) => {
			renderGroupControls(this.plugin, section(t.groupColors), base, root, info, queue);
		};

		const render = (info: BaseInfo) => {
			body.empty();
			body.createDiv({ cls: 'achmage-look-panel-title', text: t.panelTitle });
			renderThumbnails(info);
			renderGroups(info);
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
		};

		render(this.plugin.baseInfo(base) ?? this.plugin.emptyBaseInfo());

		const rect = button.getBoundingClientRect();
		const left = Math.max(8, Math.min(rect.left, doc.documentElement.clientWidth - PANEL_WIDTH - 8));
		el.setCssStyles({ top: `${rect.bottom + 6}px`, left: `${left}px` });

		const onPointer = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && (el.contains(target) || button.contains(target))) return;
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
