import { FileView, Platform, setIcon, TFile, type Menu, type WorkspaceLeaf } from 'obsidian';
import { strings } from './i18n';
import { youtubeId } from './images.ts';
import { previewSource, readLink, readThumbnail } from './storage';
import { listPixelsFor } from './baseConfig.ts';
import type { BaseSettings } from './baseSettings.ts';
import { canFoldGroups, isInternalDrag, readGroupSections, readNativeView, shownViewOf, viewElementOf, type NativeItem, type NativeType } from './native';
import { applyGroupStyle, clearGroupStyle } from './groupUi';
import { CellCursor } from './cellCursor';
import { EmbedTables } from './embeds';
import { closeFormatPanelIfGone } from './formatUi';
import { GroupOverview } from './groupOverview';
import { startPan } from './pan';
import { TableCells } from './tableCells';
import { leafTable, type TableHost } from './tableHost';
import { TOOLBAR, ToolbarControls } from './toolbar';
import { leafZoomKey, ViewZoom, type ZoomTarget } from './viewZoom';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

/** A view on screen with groups to fold: what holds its controller, and the element it is drawn in. */
interface GroupTarget {
	owner: unknown;
	root: HTMLElement;
}

/** A press that began on a thumbnail control and has not opened the thumbnail window yet. */
interface ThumbnailPress {
	path: string;
	pointerId: number;
	x: number;
	y: number;
	at: number;
}

/** A click farther than this (px) from its press, or later than this (ms), is not that press's click. */
const PRESS_SLOP = 6;
const PRESS_MS = 1000;

const SLOT = 'achmage-look-slot';
const EDIT = 'achmage-look-edit';
const LINK = 'achmage-look-link';
/** Marks the cell or list value that holds the plugin's thumbnail, the only images it tidies. */
const THUMB = 'achmage-look-thumb';
/** A press here opens the thumbnail window: the thumbnail cell of a table, the thumbnail of a list row. */
const OPEN = 'achmage-look-thumb-open';
const URL_ATTR = 'data-achmage-look-url';
const HOST = 'achmage-look-host';
const OVER = 'achmage-look-dragover';
const PATH_ATTR = 'data-achmage-look-path';

const KANBAN_START = 'achmage-look-kanban-start';
const GROUP = 'achmage-look-group';
const GROUP_COLOR_VAR = '--achmage-look-group-color';

function unmarkOpen(el: HTMLElement): void {
	el.removeClass(OPEN);
	el.removeAttribute('aria-label');
}

function hasModifier(event: MouseEvent): boolean {
	return event.shiftKey || event.ctrlKey || event.metaKey || event.altKey;
}

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
	private readonly cells: TableCells;
	/** Ctrl + wheel zoom of every Bases view, kept per view on this device. */
	private readonly zoom: ViewZoom;
	/** Group counts and folding every group at once. */
	private readonly groups = new GroupOverview();
	/** Tables that move like a spreadsheet: a press selects a cell, the keys move it. */
	private readonly cursor: CellCursor;
	/** Bases embedded in notes, code blocks, hover previews and canvas cards: their table formats and tools. */
	private readonly embeds: EmbedTables;
	/** A press on a thumbnail control, until its click (or release) opens the thumbnail window. */
	private press: ThumbnailPress | null = null;

	constructor(plugin: AchmageBasesLookPlugin) {
		this.plugin = plugin;
		this.toolbar = new ToolbarControls(plugin);
		this.cells = new TableCells((root) => this.tableHost(root));
		this.zoom = new ViewZoom(plugin.app, () => this.refreshAll());
		this.cursor = new CellCursor(plugin.app);
		this.embeds = new EmbedTables(plugin, this.cells, this.zoom, this.groups, this.cursor);
	}

	/** The zoom of the view in a Bases leaf (any layout). */
	private leafZoom(view: FileView): ZoomTarget | null {
		const name = shownViewOf(view).name;
		return name && view.file instanceof TFile ? { owner: view, key: leafZoomKey(view.file.path, name) } : null;
	}

	/** The view the zoom commands work on: the active Bases leaf, else the embedded base used last. */
	private activeZoom(): ZoomTarget | null {
		const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
		if (view?.file instanceof TFile && view.file.extension === 'base') return this.leafZoom(view);
		const host = this.embeds.activeAny();
		const name = host?.shownView().name;
		return host && name ? host.zoomTarget(name) : null;
	}

	/** Zoom commands: one step in or out, back to 100 %, or the width that fits every column. */
	zoomCommand(checking: boolean, action: 'in' | 'out' | 'reset' | 'fit'): boolean {
		const target = this.activeZoom();
		if (!target) return false;
		if (checking) return true;
		if (action === 'in') this.zoom.step(target, 1);
		else if (action === 'out') this.zoom.step(target, -1);
		else if (action === 'reset') this.zoom.reset(target);
		else this.zoom.fit(target);
		return true;
	}

	/** The view the fold commands work on: the active Bases leaf, else the embedded base used last. */
	private activeGroups(): GroupTarget | null {
		const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
		const target: GroupTarget | null = view?.file instanceof TFile && view.file.extension === 'base'
			? { owner: view, root: view.containerEl }
			: (() => {
				const host = this.embeds.activeAny();
				return host ? { owner: host.owner, root: host.root } : null;
			})();
		return target && canFoldGroups(target.owner) ? target : null;
	}

	/** Fold or unfold every group of the current view (command palette). */
	foldCommand(checking: boolean, fold: boolean): boolean {
		const target = this.activeGroups();
		if (!target) return false;
		if (!checking) this.groups.foldAll(target.owner, target.root, fold);
		return true;
	}

	/** The table a Bases leaf's view container or an embed element shows, and where its changes go. */
	tableHost(root: HTMLElement): TableHost | null {
		if (root.hasClass('bases-embed')) return this.embeds.host(root);
		return leafTable(this.plugin, this.plugin.baseView(root));
	}

	/**
	 * The table the table commands work on: a table view in the active Bases leaf, else the
	 * embedded table used last in the active note.
	 */
	activeTable(): TableHost | null {
		const view = this.plugin.app.workspace.getActiveViewOfType(FileView);
		const leaf = leafTable(this.plugin, view);
		if (leaf) return leaf.table() ? leaf : null;
		return this.embeds.active();
	}

	/** Fit columns of a table to their content: the given ones, or (null) all of them. */
	fitColumns(host: TableHost, props: string[] | null): Promise<void> {
		return this.cells.fitColumns(host, props);
	}

	/** Fit the row height of a table to its content. */
	fitRows(host: TableHost): Promise<void> {
		return this.cells.fitRows(host);
	}

	/** Open the format window for the selected cells of a table. */
	formatSelection(host: TableHost): void {
		this.cells.formatSelection(host);
	}

	/** A file menu Obsidian opened: on selected table cells it gets the format and fit items. */
	onFileMenu(menu: Menu, source: string): void {
		this.cells.onSelectionMenu(menu, source);
	}

	/** Watch a window (the main one, a popout) for hover previews that show embedded bases. */
	watchWindow(doc: Document): void {
		this.embeds.watchWindow(doc);
	}

	unwatchWindow(doc: Document): void {
		this.embeds.unwatchWindow(doc);
	}

	/** Paint embedded tables again once they have read a changed base file. */
	refreshEmbedsLater(): void {
		this.embeds.refreshLater();
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
		this.embeds.attach();
		closeFormatPanelIfGone();
	}

	refreshAll(): void {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('bases')) this.schedule(leaf);
		this.embeds.refresh();
	}

	destroy(): void {
		this.press = null;
		this.toolbar.close();
		this.cells.destroy();
		this.cursor.destroy();
		this.embeds.destroy();
		this.zoom.destroy();
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('bases')) this.groups.clear(leaf.view.containerEl);
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
			this.cells.clear(root);
			root.removeClasses(['achmage-look-hover-lift', 'achmage-look-hover-rows']);
			root.setCssProps({ '--achmage-look-aspect': '', '--achmage-look-fit': '', '--achmage-look-list-size': '', '--achmage-look-hover-color': '' });
			root.findAll(`.${SLOT}, .${EDIT}, .${LINK}, .${KANBAN_START}, .${TOOLBAR}`).forEach((el) => el.detach());
			root.findAll(`.${THUMB}`).forEach((el) => el.removeClass(THUMB));
			root.findAll(`.${OPEN}`).forEach(unmarkOpen);
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
		const native = readNativeView(view);
		const viewName = native?.viewName ?? null;
		// Everything below follows the view on screen: each view of a base has its own look.
		const look = this.plugin.viewLookOf(info, viewName);
		const shown = native && info ? (info.views.find((each) => each.name === viewName)?.thumbnails ?? info.enabled) : false;
		if (this.plugin.settings.showToolbarButton) this.toolbar.ensure(root, base, shown);
		else this.toolbar.remove(root);
		applyGroupStyle(root, look.groupStyle);
		root.toggleClass('achmage-look-hover-lift', look.hoverLift);
		root.toggleClass('achmage-look-hover-rows', look.hoverRows);
		const aspect = `${(1 / ((viewName ? info?.aspects[viewName] : undefined) ?? 1)).toFixed(4)}`;
		const props: Record<string, string> = {
			'--achmage-look-aspect': aspect,
			'--achmage-look-fit': look.fit,
			'--achmage-look-list-size': `${listPixelsFor(look.listSize)}px`,
			'--achmage-look-hover-color': look.hoverColor ?? 'var(--interactive-accent)',
		};
		const stale = Object.entries(props).some(([key, value]) => root.style.getPropertyValue(key) !== value);
		if (stale) root.setCssProps(props);
		this.decorateGroups(view, root, info?.groupColors ?? {});
		// Zoom (this device) and group counts, in every layout.
		const zoom = this.leafZoom(view);
		if (zoom) this.zoom.apply(zoom);
		this.groups.decorate(view, root, look.groupCounts && native?.type !== 'kanban');
		// Cell formats and moving through the cells belong to table views, with or without thumbnails.
		if (native?.type === 'table' && viewName) {
			this.cells.decorate(view, root, info?.formats[viewName] ?? null);
			this.cursor.update(view, root, look.cellSelect, false);
		} else {
			this.cells.clear(root);
			this.cursor.clear(root);
		}

		this.decorateKanbanStart(root, base, info, viewName);
		// Only views that show this base's thumbnail property get frames and buttons; a view with
		// its own images (another property, a file, a formula) is left as it is.
		if (!native || !info || !shown) {
			this.clearItems(root);
			return;
		}
		const formulaCell = info.formula ? `.bases-td[data-property="formula.${CSS.escape(info.formula)}"] .bases-table-cell` : null;
		for (const item of native.items) {
			const host = this.hostFor(native.type, item, formulaCell);
			if (host) this.decorateHost(native.type, host, item.file, info.settings, info.managed && look.tidy, look.placeholders);
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

	private decorateHost(type: NativeType, host: HTMLElement, file: TFile, settings: BaseSettings, tidy: boolean, placeholders: boolean): void {
		const t = strings();
		const inline = type === 'table' || type === 'list';
		const image = inline ? this.thumbnailImage(type, host, file, settings.thumbnailProperty) : null;
		const hasImage = this.plugin.hasThumbnail(file, settings.thumbnailProperty) || image !== null;
		if (host.getAttribute(PATH_ATTR) !== file.path) host.setAttribute(PATH_ATTR, file.path);
		if (!host.hasClass(HOST)) host.addClass(HOST);
		if (inline) {
			this.markThumbnail(type, host, tidy ? image : null);
			this.markOpen(type, host, image);
		}

		if (hasImage) this.decorateLink(host, file, inline ? image?.parentElement ?? null : host, inline, settings.linkProperty);
		else host.find(`.${LINK}`)?.detach();

		const slot = host.find(`.${SLOT}`);
		const edit = host.find(`.${EDIT}`);
		if (hasImage || !placeholders) {
			slot?.detach();
			if (hasImage && !inline && placeholders) {
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

	/**
	 * Tables and lists have no change button on a thumbnail, as cards have: a press on it opens the
	 * thumbnail window instead. In a table anywhere in the thumbnail cell, empty or not, so the
	 * small empty frame needs no aim; in a list on the image (the rest of the row opens the note).
	 */
	private markOpen(type: NativeType, host: HTMLElement, image: HTMLElement | null): void {
		const target = type === 'table' ? host : image;
		if (host !== target && host.hasClass(OPEN)) unmarkOpen(host);
		for (const el of host.findAll(`.${OPEN}`)) if (el !== target) unmarkOpen(el);
		if (!target || target.hasClass(OPEN)) return;
		target.addClass(OPEN);
		target.setAttribute('aria-label', strings().editThumbnail);
	}

	/** Tidy only the plugin's own thumbnail (in a base it set up); other images keep Obsidian's look. */
	private markThumbnail(type: NativeType, host: HTMLElement, image: HTMLElement | null): void {
		const target = !image ? null : type === 'table' ? host : image.closest<HTMLElement>('.bases-list-property');
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
		root.findAll(`.${OPEN}`).forEach(unmarkOpen);
		root.findAll(`[${PATH_ATTR}]`).forEach((el) => {
			el.removeAttribute(PATH_ATTR);
			el.removeClasses([HOST, OVER]);
		});
	}

	/** Open the look panel of a base view (command palette). */
	openPanel(view: FileView): void {
		if (view.file instanceof TFile) this.toolbar.openPanel(view.containerEl, view.file);
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

	private openThumbnail(path: string, root: HTMLElement): void {
		const file = this.plugin.app.vault.getFileByPath(path);
		if (file instanceof TFile) this.plugin.openThumbnailModal(file, this.baseOf(root));
	}

	/**
	 * A press on a thumbnail control: an empty frame, a change button, a table's thumbnail cell.
	 * A press on a table cell makes Bases draw the table again while the button is still down, and
	 * the click then lands on the row around the control, or does not come at all: the press
	 * itself remembers which note it was for.
	 */
	private notePress(event: PointerEvent): void {
		this.press = null;
		if (event.button !== 0 || !event.isPrimary || hasModifier(event) || !(event.target instanceof Element)) return;
		if (event.target.closest(`.${LINK}`) || !event.target.closest(`.${SLOT}, .${EDIT}, .${OPEN}`)) return;
		const path = event.target.closest(`[${PATH_ATTR}]`)?.getAttribute(PATH_ATTR);
		if (path) this.press = { path, pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
	}

	/** The remembered press that this click or release (of that pointer) ends: soon after it, at the same place. */
	private pressFor(event: MouseEvent, pointerId: number | null = null): ThumbnailPress | null {
		const press = this.press;
		if (!press || event.timeStamp - press.at > PRESS_MS) return null;
		if (pointerId !== null && pointerId !== press.pointerId) return null;
		return Math.hypot(event.clientX - press.x, event.clientY - press.y) <= PRESS_SLOP ? press : null;
	}

	/** The release of a remembered press: when no click opens the window for it, open it after all. */
	private onPressEnd(event: PointerEvent, root: HTMLElement): void {
		const press = this.pressFor(event, event.pointerId);
		if (!press) {
			if (this.press?.pointerId === event.pointerId) this.press = null;
			return;
		}
		// The click follows the release in the same task, so this runs after it.
		root.win.setTimeout(() => {
			if (this.press !== press) return;
			this.press = null;
			this.openThumbnail(press.path, root);
		}, 0);
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
			const press = event instanceof MouseEvent ? this.pressFor(event) : null;
			if (press) {
				this.press = null;
				event.preventDefault();
				event.stopPropagation();
				this.openThumbnail(press.path, root);
				return;
			}
			if (!event.target.closest(`.${SLOT}, .${EDIT}, .${OPEN}`)) return;
			// Shift, Ctrl and Alt clicks keep Obsidian's behavior: selecting cells, opening the note.
			if (event instanceof MouseEvent && hasModifier(event)) return;
			const file = this.fileAt(event.target);
			if (!file) return;
			if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			event.stopPropagation();
			this.plugin.openThumbnailModal(file, this.baseOf(root));
		};
		this.plugin.registerDomEvent(root, 'click', onActivate, { capture: true });
		this.plugin.registerDomEvent(root, 'keydown', onActivate, { capture: true });
		this.plugin.registerDomEvent(root, 'pointerup', (event) => this.onPressEnd(event, root), { capture: true });

		// Overview: Ctrl + wheel (or a pinch) zooms the view, Alt + click on a group heading folds
		// every group, the middle button drags the view around.
		this.plugin.registerDomEvent(root, 'wheel', (event) => {
			if (!ViewZoom.isZoomWheel(event)) return;
			const view = this.plugin.baseView(root);
			const target = view ? this.leafZoom(view) : null;
			if (!view || !target || !(event.target instanceof Node) || !viewElementOf(view)?.contains(event.target)) return;
			this.zoom.onWheel(event, target);
		}, { passive: false });
		this.plugin.registerDomEvent(root, 'click', (event) => {
			const view = this.plugin.baseView(root);
			if (view) this.groups.onClick(event, root, view);
		}, { capture: true });

		// Table tools. The menu items are added after Obsidian's own handlers (bubbling), the
		// double-click and the row line handle come first (capture).
		this.plugin.registerDomEvent(root, 'contextmenu', (event) => this.cells.noteRightClick(event, root), { capture: true });
		this.plugin.registerDomEvent(root, 'contextmenu', (event) => this.cells.onContextMenu(event, root));
		if (Platform.isMobile) this.plugin.registerDomEvent(root, 'click', (event) => this.cells.onTap(event, root));
		this.plugin.registerDomEvent(root, 'dblclick', (event) => this.cells.onDoubleClick(event, root), { capture: true });
		// A press on a cell selects it (after the row line handle, which may take the press).
		this.plugin.registerDomEvent(root, 'pointerdown', (event) => {
			this.notePress(event);
			const view = this.plugin.baseView(root);
			if (view && startPan(event, root, view)) return;
			this.cells.onPointerDown(event, root);
			this.cursor.beforePress(event, root);
		}, { capture: true });
		this.plugin.registerDomEvent(root, 'dragstart', (event) => this.cells.onDragStart(event, root), { capture: true });
		this.plugin.registerDomEvent(root, 'click', (event) => this.cells.onClick(event), { capture: true });
		this.plugin.registerDomEvent(root, 'pointermove', (event) => this.cells.onPointerMove(event, root), { passive: true });
		this.plugin.registerDomEvent(root, 'pointerleave', () => this.cells.onPointerLeave(root));
		this.plugin.registerDomEvent(root, 'mousedown', (event) => {
			if (!(event.target instanceof Element)) return;
			const control = event.target.closest(`.${SLOT}, .${EDIT}, .${LINK}, .${OPEN}`);
			if (!control) return;
			// Kanban cards start a drag on mousedown; keep that from happening on the slot.
			if (!control.hasClass(OPEN)) event.stopPropagation();
			// A plain press leaves the focus where it is. Focus inside a table cell makes Obsidian
			// size the cell to its content: the frame shrank under the pointer, and the click that
			// should open the thumbnail window landed beside it.
			if (event.button === 0 && !hasModifier(event)) event.preventDefault();
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
