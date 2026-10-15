import { FileView, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { strings } from './i18n';
import { youtubeId } from './images.ts';
import { previewSource, readLink, readThumbnail } from './storage';
import { listPixelsFor } from './baseConfig.ts';
import type { BaseSettings } from './baseSettings.ts';
import { isInternalDrag, readGroupSections, readNativeView, type NativeItem, type NativeType } from './native';
import { applyGroupStyle, clearGroupStyle } from './groupUi';
import { TOOLBAR, ToolbarControls } from './toolbar';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

const SLOT = 'achmage-look-slot';
const EDIT = 'achmage-look-edit';
const LINK = 'achmage-look-link';
/** Marks the cell or list value that holds the plugin's thumbnail, the only images it tidies. */
const THUMB = 'achmage-look-thumb';
const URL_ATTR = 'data-achmage-look-url';
const HOST = 'achmage-look-host';
const OVER = 'achmage-look-dragover';
const PATH_ATTR = 'data-achmage-look-path';

const KANBAN_START = 'achmage-look-kanban-start';
const GROUP = 'achmage-look-group';
const GROUP_COLOR_VAR = '--achmage-look-group-color';

function hasExternalPayload(event: DragEvent): boolean {
	const types = Array.from(event.dataTransfer?.types ?? []);
	return types.includes('Files') || types.includes('text/uri-list');
}

/**
 * Decorates open Bases views. Watches each view with a MutationObserver because the
 * views are virtualized: cards and rows are recycled while scrolling.
 */
export class BasesOverlay {
	private readonly plugin: AchmageBasesLookPlugin;
	private readonly observers = new Map<HTMLElement, MutationObserver>();
	private readonly listening = new WeakSet<HTMLElement>();
	private readonly pending = new Set<WorkspaceLeaf>();
	private frame = 0;
	private readonly toolbar: ToolbarControls;

	constructor(plugin: AchmageBasesLookPlugin) {
		this.plugin = plugin;
		this.toolbar = new ToolbarControls(plugin);
	}

	/** Find Bases leaves and make sure each one is watched. */
	attachAll(): void {
		const live = new Set<HTMLElement>();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('bases')) {
			const root = leaf.view.containerEl;
			live.add(root);
			if (!this.observers.has(root)) {
				const observer = new MutationObserver(() => this.schedule(leaf));
				observer.observe(root, { childList: true, subtree: true });
				this.observers.set(root, observer);
			}
			if (!this.listening.has(root)) this.listen(root);
			this.schedule(leaf);
		}
		for (const [root, observer] of this.observers) {
			if (!live.has(root)) {
				observer.disconnect();
				this.observers.delete(root);
			}
		}
	}

	refreshAll(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('bases')) this.schedule(leaf);
	}

	destroy(): void {
		this.toolbar.close();
		activeDocument.body.findAll(`.${GROUP}`).forEach((el) => {
			el.removeClass(GROUP);
			el.setCssProps({ [GROUP_COLOR_VAR]: '' });
		});
		for (const observer of this.observers.values()) observer.disconnect();
		this.observers.clear();
		if (this.frame) window.cancelAnimationFrame(this.frame);
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('bases')) {
			const root = leaf.view.containerEl;
			clearGroupStyle(root);
			root.setCssProps({ '--achmage-look-aspect': '', '--achmage-look-fit': '' });
			root.findAll(`.${SLOT}, .${EDIT}, .${TOOLBAR}`).forEach((el) => el.detach());
			root.findAll(`[${PATH_ATTR}]`).forEach((el) => {
				el.removeAttribute(PATH_ATTR);
				el.removeClasses([HOST, OVER]);
			});
		}
	}

	private schedule(leaf: WorkspaceLeaf): void {
		this.pending.add(leaf);
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = 0;
			const leaves = Array.from(this.pending);
			this.pending.clear();
			for (const each of leaves) this.decorate(each);
		});
	}

	private decorate(leaf: WorkspaceLeaf): void {
		const view = leaf.view;
		if (!(view instanceof FileView) || !(view.file instanceof TFile) || view.file.extension !== 'base') return;
		const base = view.file;
		const root = view.containerEl;
		const info = this.plugin.baseInfo(base, () => this.schedule(leaf));
		if (this.plugin.settings.showToolbarButton) this.toolbar.ensure(root, base, info?.enabled ?? false);
		else this.toolbar.remove(root);
		applyGroupStyle(root, this.plugin.effectiveGroupStyle(info));
		// Shape and fit of table and list thumbnails follow the base's thumbnail look.
		const aspect = `${(1 / (info?.aspect ?? 1)).toFixed(4)}`;
		const fit = info?.look.fit === 'contain' ? 'contain' : 'cover';
		if (root.style.getPropertyValue('--achmage-look-aspect') !== aspect || root.style.getPropertyValue('--achmage-look-fit') !== fit) {
			root.setCssProps({ '--achmage-look-aspect': aspect, '--achmage-look-fit': fit });
		}
		this.decorateGroups(view, root, info?.groupColors ?? {});
		// List thumbnail size is a setting of each base.
		const listSize = `${listPixelsFor(info?.settings.listSize ?? this.plugin.settings.listSize)}px`;
		if (root.style.getPropertyValue('--achmage-look-list-size') !== listSize) root.setCssProps({ '--achmage-look-list-size': listSize });

		const native = readNativeView(view);
		this.decorateKanbanStart(root, base, info, native?.viewName ?? null);
		// Only views that show this base's thumbnail property get frames and buttons; a view with
		// its own images (another property, a file, a formula) is left as it is.
		const shown = native && info ? (info.views.find((each) => each.name === native.viewName)?.thumbnails ?? info.enabled) : false;
		if (!native || !info || !shown) {
			this.clearItems(root);
			return;
		}
		const formulaCell = info.formula ? `.bases-td[data-property="formula.${CSS.escape(info.formula)}"] .bases-table-cell` : null;
		for (const item of native.items) {
			const host = this.hostFor(native.type, item, formulaCell);
			if (host) this.decorateHost(native.type, host, item.file, info.settings, info.managed);
		}
	}

	/**
	 * A kanban view without a group property shows Obsidian's “Choose a property”. When it was
	 * not grouped automatically (the user removed the grouping, or the setting is off), offer a
	 * one-click start next to Obsidian's own button.
	 */
	private decorateKanbanStart(root: HTMLElement, base: TFile, info: BaseInfo | null, viewName: string | null): void {
		const placeholder = root.find('.bases-kanban-placeholder');
		const view = info?.views.find((each) => each.name === viewName) ?? null;
		const existing = root.find(`.${KANBAN_START}`);
		if (!placeholder || !viewName || view?.type !== 'kanban' || view.groupBy) {
			existing?.detach();
			return;
		}
		if (existing && placeholder.contains(existing)) return;
		existing?.detach();
		const property = this.plugin.kanbanGroupPropertyFor(base);
		const button = placeholder.createEl('button', { cls: [KANBAN_START, 'mod-cta'], text: strings().kanbanStart(property) });
		button.addEventListener('click', () => {
			button.disabled = true;
			void this.plugin.groupKanbanView(base, viewName);
		});
	}

	/**
	 * Give every group section (kanban column, card group, table group, list group) its color.
	 * Uses only the visible group headings, which look the same in all four views.
	 */
	private decorateGroups(view: FileView, root: HTMLElement, colors: Record<string, string>): void {
		const colored = new Set<HTMLElement>();
		for (const { value, heading, section } of readGroupSections(view, root)) {
			const color = colors[value];
			if (!color) continue;
			for (const el of [section, heading]) {
				colored.add(el);
				if (!el.hasClass(GROUP)) el.addClass(GROUP);
				if (el.style.getPropertyValue(GROUP_COLOR_VAR) !== color) el.setCssProps({ [GROUP_COLOR_VAR]: color });
			}
		}
		for (const el of root.findAll(`.${GROUP}`)) {
			if (colored.has(el)) continue;
			el.removeClass(GROUP);
			el.setCssProps({ [GROUP_COLOR_VAR]: '' });
		}
	}

	private hostFor(type: NativeType, item: NativeItem, formulaCell: string | null): HTMLElement | null {
		if (type === 'cards' || type === 'kanban') return item.cover;
		if (type === 'table') return formulaCell ? item.el.find(formulaCell) : null;
		return item.el.find('.bases-list-item-properties');
	}

	private decorateHost(type: NativeType, host: HTMLElement, file: TFile, settings: BaseSettings, managed: boolean): void {
		const t = strings();
		const inline = type === 'table' || type === 'list';
		const image = inline ? this.thumbnailImage(type, host, file, settings.thumbnailProperty) : null;
		const hasImage = this.plugin.hasThumbnail(file, settings.thumbnailProperty) || image !== null;
		if (host.getAttribute(PATH_ATTR) !== file.path) host.setAttribute(PATH_ATTR, file.path);
		if (!host.hasClass(HOST)) host.addClass(HOST);
		if (inline) this.markThumbnail(type, host, managed ? image : null);

		if (hasImage) this.decorateLink(host, file, inline ? image?.parentElement ?? null : host, inline, settings.linkProperty);
		else host.find(`.${LINK}`)?.detach();

		const slot = host.find(`.${SLOT}`);
		const edit = host.find(`.${EDIT}`);
		if (hasImage || !this.plugin.settings.showPlaceholders) {
			slot?.detach();
			if (hasImage && !inline && this.plugin.settings.showPlaceholders) {
				if (!edit) {
					const button = host.createDiv({ cls: EDIT, attr: { role: 'button', 'aria-label': t.editThumbnail, tabindex: '0' } });
					setIcon(button, 'image-plus');
				}
			} else {
				edit?.detach();
			}
			return;
		}
		edit?.detach();
		if (slot) return;
		// The cover frame shows its text, so only the small inline frame needs a label (and its tooltip).
		const created = createDiv({ cls: [SLOT, inline ? 'mod-inline' : 'mod-cover'], attr: inline ? { role: 'button', 'aria-label': t.slotHint, tabindex: '0' } : { role: 'button', tabindex: '0' } });
		setIcon(created.createDiv({ cls: 'achmage-look-slot-icon' }), 'image-plus');
		if (!inline) {
			created.createDiv({ cls: 'achmage-look-slot-label', text: t.slotLabel });
			created.createDiv({ cls: 'achmage-look-slot-hint', text: t.slotHint });
		}
		// In a list row, sit right after the bullet, where an image would be.
		const bullet = type === 'list' ? host.find('.list-bullet') : null;
		if (bullet) bullet.after(created);
		else if (type === 'list') host.prepend(created);
		else host.appendChild(created);
	}

	/**
	 * The image of this base's thumbnail in a table cell or list row. In a list it is the image
	 * that shows the note's thumbnail value, not some other image property of the row.
	 */
	private thumbnailImage(type: NativeType, host: HTMLElement, file: TFile, property: string): HTMLElement | null {
		if (type === 'table') return host.find('img');
		const value = readThumbnail(this.plugin.app, file, property);
		const source = value ? previewSource(this.plugin.app, file, value) : null;
		if (!source) return null;
		const wanted = source.split('?')[0];
		return host.findAll('img').find((img) => (img.getAttribute('src') ?? '').split('?')[0] === wanted) ?? null;
	}

	/** Tidy only the plugin's own thumbnail (in a base it set up); other images keep Obsidian's look. */
	private markThumbnail(type: NativeType, host: HTMLElement, image: HTMLElement | null): void {
		const tidy = this.plugin.settings.tidyImages;
		const target = !tidy || !image ? null : type === 'table' ? host : image.closest<HTMLElement>('.bases-list-property');
		if (type === 'table') host.toggleClass(THUMB, target !== null);
		else for (const el of host.findAll(`.${THUMB}`)) if (el !== target) el.removeClass(THUMB);
		if (target && !target.hasClass(THUMB)) target.addClass(THUMB);
	}

	/**
	 * An open button on the thumbnail when the note's link property holds a web address:
	 * a play button for YouTube, a small corner button for other pages.
	 */
	private decorateLink(host: HTMLElement, file: TFile, target: HTMLElement | null, inline: boolean, linkProperty: string): void {
		const url = readLink(this.plugin.app, file, linkProperty);
		const existing = host.find(`.${LINK}`);
		if (!url || !target) {
			existing?.detach();
			return;
		}
		if (existing && existing.parentElement === target && existing.getAttribute(URL_ATTR) === url) return;
		existing?.detach();
		const video = youtubeId(url) !== null;
		const t = strings();
		const button = target.createDiv({
			cls: [LINK, video ? 'mod-video' : 'mod-web', inline ? 'mod-inline' : 'mod-cover'],
			attr: { role: 'button', tabindex: '0', 'aria-label': video ? t.openVideo : t.openLink, [URL_ATTR]: url },
		});
		setIcon(button, video ? 'play' : 'external-link');
	}

	private clearItems(root: HTMLElement): void {
		root.findAll(`.${SLOT}, .${EDIT}, .${LINK}`).forEach((el) => el.detach());
		root.findAll(`.${THUMB}`).forEach((el) => el.removeClass(THUMB));
		root.findAll(`[${PATH_ATTR}]`).forEach((el) => {
			el.removeAttribute(PATH_ATTR);
			el.removeClasses([HOST, OVER]);
		});
	}

	/** The base file shown in a view container. */
	private baseOf(root: HTMLElement): TFile | null {
		const leaf = this.plugin.app.workspace.getLeavesOfType('bases').find((each) => each.view.containerEl === root);
		return leaf?.view instanceof FileView && leaf.view.file instanceof TFile ? leaf.view.file : null;
	}

	private fileAt(target: EventTarget | null): TFile | null {
		if (!(target instanceof Element)) return null;
		const host = target.closest(`[${PATH_ATTR}]`);
		const path = host?.getAttribute(PATH_ATTR);
		const file = path ? this.plugin.app.vault.getFileByPath(path) : null;
		return file instanceof TFile ? file : null;
	}

	/** One set of delegated listeners per view, so recycled cards need no listeners of their own. */
	private listen(root: HTMLElement): void {
		this.listening.add(root);
		const onActivate = (event: Event) => {
			if (!(event.target instanceof Element)) return;
			const link = event.target.closest(`.${LINK}`);
			if (link) {
				if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
				event.preventDefault();
				event.stopPropagation();
				const url = link.getAttribute(URL_ATTR);
				// Obsidian opens web addresses in the system browser.
				if (url) window.open(url, '_blank');
				return;
			}
			if (!event.target.closest(`.${SLOT}, .${EDIT}`)) return;
			const file = this.fileAt(event.target);
			if (!file) return;
			if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			this.plugin.openThumbnailModal(file, this.baseOf(root));
		};
		this.plugin.registerDomEvent(root, 'click', onActivate, { capture: true });
		this.plugin.registerDomEvent(root, 'keydown', onActivate, { capture: true });
		// Kanban cards start a drag on mousedown; keep that from happening on the slot.
		this.plugin.registerDomEvent(root, 'mousedown', (event) => {
			if (event.target instanceof Element && event.target.closest(`.${SLOT}, .${EDIT}, .${LINK}`)) event.stopPropagation();
		}, { capture: true });

		this.plugin.registerDomEvent(root, 'dragover', (event) => {
			if (!hasExternalPayload(event) || isInternalDrag(this.plugin.app)) return;
			const host = event.target instanceof Element ? event.target.closest(`[${PATH_ATTR}]`) : null;
			if (!host) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
			root.findAll(`.${OVER}`).forEach((el) => {
				if (el !== host) el.removeClass(OVER);
			});
			host.addClass(OVER);
		}, { capture: true });
		this.plugin.registerDomEvent(root, 'dragleave', (event) => {
			const host = event.target instanceof Element ? event.target.closest(`[${PATH_ATTR}]`) : null;
			if (host && !(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) host.removeClass(OVER);
		}, { capture: true });
		this.plugin.registerDomEvent(root, 'drop', (event) => {
			if (!hasExternalPayload(event) || isInternalDrag(this.plugin.app)) return;
			const file = this.fileAt(event.target);
			if (!file || !event.dataTransfer) return;
			event.preventDefault();
			event.stopPropagation();
			root.findAll(`.${OVER}`).forEach((el) => el.removeClass(OVER));
			void this.plugin.addFromDataTransfer(file, event.dataTransfer, this.baseOf(root));
		}, { capture: true });
	}
}
