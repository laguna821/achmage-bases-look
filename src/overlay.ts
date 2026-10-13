import { FileView, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';
import { strings } from './i18n';
import { isInternalDrag, readGroupSections, readNativeView, type NativeItem, type NativeType } from './native';
import { applyGroupStyle, clearGroupStyle } from './groupUi';
import { TOOLBAR, ToolbarControls } from './toolbar';
import type AchmageBasesLookPlugin from '../main';

const SLOT = 'achmage-look-slot';
const EDIT = 'achmage-look-edit';
const HOST = 'achmage-look-host';
const OVER = 'achmage-look-dragover';
const PATH_ATTR = 'data-achmage-look-path';

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
		this.decorateGroups(view, root, info?.groupColors ?? {});

		const native = readNativeView(view);
		if (!native || !info?.enabled) {
			this.clearItems(root);
			return;
		}
		const formulaCell = info.formula ? `.bases-td[data-property="formula.${CSS.escape(info.formula)}"] .bases-table-cell` : null;
		for (const item of native.items) {
			const host = this.hostFor(native.type, item, formulaCell);
			if (host) this.decorateHost(native.type, host, item.file);
		}
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

	private decorateHost(type: NativeType, host: HTMLElement, file: TFile): void {
		const t = strings();
		const inline = type === 'table' || type === 'list';
		const hasImage = this.plugin.hasThumbnail(file) || (inline && host.find('img') !== null);
		if (host.getAttribute(PATH_ATTR) !== file.path) host.setAttribute(PATH_ATTR, file.path);
		if (!host.hasClass(HOST)) host.addClass(HOST);

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

	private clearItems(root: HTMLElement): void {
		root.findAll(`.${SLOT}, .${EDIT}`).forEach((el) => el.detach());
		root.findAll(`[${PATH_ATTR}]`).forEach((el) => {
			el.removeAttribute(PATH_ATTR);
			el.removeClasses([HOST, OVER]);
		});
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
			if (!(event.target instanceof Element) || !event.target.closest(`.${SLOT}, .${EDIT}`)) return;
			const file = this.fileAt(event.target);
			if (!file) return;
			if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			this.plugin.openThumbnailModal(file);
		};
		this.plugin.registerDomEvent(root, 'click', onActivate, { capture: true });
		this.plugin.registerDomEvent(root, 'keydown', onActivate, { capture: true });
		// Kanban cards start a drag on mousedown; keep that from happening on the slot.
		this.plugin.registerDomEvent(root, 'mousedown', (event) => {
			if (event.target instanceof Element && event.target.closest(`.${SLOT}, .${EDIT}`)) event.stopPropagation();
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
			void this.plugin.addFromDataTransfer(file, event.dataTransfer);
		}, { capture: true });
	}
}
