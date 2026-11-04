import { Notice, Platform, View, type TFile } from 'obsidian';
import { closeFormatPanelIfGone } from './formatUi';
import { strings } from './i18n';
import {
	editEmbedQuery, embedBaseFile, embedElementOf, embedQueryText, embedShownView, embedViewSetting, findEmbedControllers, readNativeTable,
	type NativeTable,
} from './native';
import { clearTableFormat, readLookFormat, writeTableFormat, type FormatChange, type FormatTarget, type RowPreset, type TableFormat } from './tableFormat.ts';
import type { TableCells } from './tableCells';
import type { TableHost } from './tableHost';
import type AchmageBasesLookPlugin from '../main';
import type { BaseInfo } from '../main';

/** The element Bases draws an embedded base into (a file embed, a code block). */
const EMBED = 'bases-embed';
const POPOVER = 'hover-popover';
/** An embed whose controller was not found is looked for again after this long, then twice as long … */
const RETRY_MS = 2000;
const RETRY_MAX_MS = 60000;
/** After a base file changes, its embeds read it again; they are painted once more after this. */
const RELOAD_MS = 450;

/**
 * The table of a base embedded in a note, a code block, a hover preview or a canvas card. Bases
 * keeps such a base in memory and saves it itself: a change made here goes through Bases, so it
 * shows at once and is saved where the embed keeps its base, the base file or the code block.
 */
export class EmbedTable implements TableHost {
	readonly embedded = true;
	readonly root: HTMLElement;
	private readonly plugin: AchmageBasesLookPlugin;
	private readonly controller: unknown;
	private readonly changed: (root: HTMLElement) => void;

	constructor(plugin: AchmageBasesLookPlugin, root: HTMLElement, controller: unknown, changed: (root: HTMLElement) => void) {
		this.plugin = plugin;
		this.root = root;
		this.controller = controller;
		this.changed = changed;
	}

	get base(): TFile | null {
		return embedBaseFile(this.controller);
	}

	/** What `readNativeTable` and `TableCells.decorate` read, as they read a Bases leaf. */
	get owner(): { controller: unknown } {
		return { controller: this.controller };
	}

	owns(controller: unknown): boolean {
		return this.controller === controller;
	}

	alive(): boolean {
		return embedElementOf(this.controller) === this.root;
	}

	/** Layout and name of the view shown, without reading the whole table. */
	shownView(): { type: string | null; name: string | null } {
		return embedShownView(this.controller);
	}

	table(): NativeTable | null {
		return readNativeTable(this.owner);
	}

	info(): BaseInfo | null {
		const text = embedQueryText(this.controller);
		return text === null ? null : this.plugin.describeText(text);
	}

	format(viewName: string): TableFormat {
		return readLookFormat(embedViewSetting(this.controller, viewName, 'achmageLook'));
	}

	setFormat(viewName: string, target: FormatTarget, change: FormatChange): Promise<void> {
		return this.edit((draft) => {
			writeTableFormat(draft, viewName, target, change);
		});
	}

	clearFormat(viewName: string, target: FormatTarget | null): Promise<void> {
		return this.edit((draft) => {
			clearTableFormat(draft, viewName, target);
		});
	}

	setColumnWidths(viewName: string, widths: Record<string, number | null>, fitThumbnails: boolean): Promise<void> {
		const table = this.table();
		const rest: Record<string, number | null> = {};
		for (const [prop, width] of Object.entries(widths)) {
			// Bases holds widths in memory as well; its own reset clears both, its settings alone would not.
			if (width === null && table?.viewName === viewName && table.resetWidth(prop)) continue;
			rest[prop] = width;
		}
		if (Object.keys(rest).length === 0 && !fitThumbnails) {
			this.changed(this.root);
			return Promise.resolve();
		}
		return this.edit((draft) => this.plugin.editColumnWidths(draft, viewName, rest, fitThumbnails));
	}

	setRowHeight(viewName: string, preset: RowPreset): Promise<void> {
		return this.edit((draft) => this.plugin.editViewOptions(draft, viewName, { rowHeight: preset }));
	}

	/**
	 * Change the embedded base as the same change would change a base file: on the base as Bases
	 * holds it now (saved or not), handed back to Bases setting by setting.
	 */
	private edit(change: (draft: Record<string, unknown>) => void): Promise<void> {
		const text = this.alive() ? embedQueryText(this.controller) : null;
		const draft = text === null ? null : this.plugin.parseBaseText(text);
		let done = false;
		if (draft) {
			try {
				change(draft);
				done = editEmbedQuery(this.controller, draft);
			} catch {
				done = false;
			}
		}
		if (!done) new Notice(strings().embedUnchanged);
		this.changed(this.root);
		return Promise.resolve();
	}
}

/**
 * Finds the bases embedded in notes, code blocks, hover previews and canvas cards, shows the
 * table formats of their table views and gives them the table tools of a Bases leaf. Watches
 * every leaf that is not a Bases leaf and every hover preview, and reacts only to changes inside
 * an embed or to embeds coming and going.
 */
export class EmbedTables {
	private readonly plugin: AchmageBasesLookPlugin;
	private readonly cells: TableCells;
	/** Embeds found so far, by their `.bases-embed` element. */
	private readonly hosts = new WeakMap<HTMLElement, EmbedTable>();
	/** Embeds whose controller was looked for in vain: when, and how long until the next try. */
	private readonly misses = new WeakMap<HTMLElement, { at: number; wait: number }>();
	/** Leaf views and hover previews watched for embeds. */
	private readonly watched = new Map<HTMLElement, MutationObserver>();
	/** The window bodies watched for hover previews. */
	private readonly windows = new Map<Document, MutationObserver>();
	/** The table listeners of each embed on screen. */
	private readonly listening = new Map<HTMLElement, AbortController>();
	private readonly dirty = new Set<HTMLElement>();
	private readonly retries = new Set<number>();
	private frame = 0;
	private later = 0;
	/** The workspace was walked during the paint going on now. */
	private walked = false;
	/** The embed used last, for the table commands. */
	private lastUsed: WeakRef<HTMLElement> | null = null;

	constructor(plugin: AchmageBasesLookPlugin, cells: TableCells) {
		this.plugin = plugin;
		this.cells = cells;
	}

	/** Watch every leaf that is not a Bases leaf (notes, canvases …) and stop watching closed ones. */
	attach(): void {
		const live = new Set<HTMLElement>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view.getViewType() === 'bases') return;
			const root = leaf.view.containerEl;
			live.add(root);
			this.watchWindow(root.doc);
			if (!this.watched.has(root)) {
				this.watch(root);
				this.schedule(root);
			}
		});
		for (const [root, observer] of this.watched) {
			if (root.hasClass(POPOVER) ? root.isConnected : live.has(root)) continue;
			observer.disconnect();
			this.watched.delete(root);
		}
		this.prune();
	}

	/** Watch a window for hover previews, which Obsidian adds to the window's body. */
	watchWindow(doc: Document): void {
		if (this.windows.has(doc) || !doc.body) return;
		const observer = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of Array.from(record.addedNodes)) {
					if (node.instanceOf(HTMLElement) && node.hasClass(POPOVER)) this.watchPopover(node);
				}
				for (const node of Array.from(record.removedNodes)) {
					if (!node.instanceOf(HTMLElement)) continue;
					this.watched.get(node)?.disconnect();
					if (this.watched.delete(node)) this.prune();
				}
			}
		});
		observer.observe(doc.body, { childList: true });
		this.windows.set(doc, observer);
		for (const child of Array.from(doc.body.children)) {
			if (child.instanceOf(HTMLElement) && child.hasClass(POPOVER)) this.watchPopover(child);
		}
	}

	unwatchWindow(doc: Document): void {
		this.windows.get(doc)?.disconnect();
		this.windows.delete(doc);
		for (const [root, observer] of this.watched) {
			if (root.doc !== doc) continue;
			observer.disconnect();
			this.watched.delete(root);
		}
		this.prune();
	}

	/** Paint every embed again (theme change, notes changed, base files changed). */
	refresh(): void {
		for (const root of this.watched.keys()) this.schedule(root);
	}

	/** Paint again a moment from now, after embeds have read a changed base file again. */
	refreshLater(): void {
		window.clearTimeout(this.later);
		this.later = window.setTimeout(() => {
			this.later = 0;
			this.refresh();
		}, RELOAD_MS);
	}

	/** The table host of an embed element (for a right-click, a double-click …), or null. */
	host(el: HTMLElement): EmbedTable | null {
		return el.hasClass(EMBED) ? this.resolve(el, true) : null;
	}

	/** The embed used last, while it is on screen in the active leaf or in a hover preview. */
	active(): EmbedTable | null {
		const el = this.lastUsed?.deref();
		if (!el?.isConnected || !el.isShown()) return null;
		const view = this.plugin.app.workspace.getActiveViewOfType(View);
		if (!view?.containerEl.contains(el) && !el.closest(`.${POPOVER}`)) return null;
		const host = this.resolve(el);
		return host?.table() ? host : null;
	}

	destroy(): void {
		if (this.frame) window.cancelAnimationFrame(this.frame);
		window.clearTimeout(this.later);
		for (const timer of this.retries) window.clearTimeout(timer);
		this.retries.clear();
		this.frame = 0;
		this.dirty.clear();
		for (const observer of this.windows.values()) observer.disconnect();
		this.windows.clear();
		for (const root of this.watched.keys()) root.findAll(`.${EMBED}`).forEach((el) => this.cells.clear(el));
		for (const observer of this.watched.values()) observer.disconnect();
		this.watched.clear();
		for (const [el, stop] of this.listening) {
			stop.abort();
			this.cells.clear(el);
		}
		this.listening.clear();
		this.lastUsed = null;
	}

	private watchPopover(popover: HTMLElement): void {
		if (this.watched.has(popover)) return;
		this.watch(popover);
		this.schedule(popover);
	}

	private watch(root: HTMLElement): void {
		const observer = new MutationObserver((records) => this.onMutations(root, records));
		observer.observe(root, { childList: true, subtree: true });
		this.watched.set(root, observer);
	}

	/**
	 * Changes inside an embed (Bases redraws rows while scrolling) paint that embed again; embeds
	 * coming or going have the whole root looked at again. Anything else is ignored.
	 */
	private onMutations(root: HTMLElement, records: MutationRecord[]): void {
		for (const record of records) {
			const target = record.target.instanceOf(Element) ? record.target : record.target.parentElement;
			const embed = target?.closest<HTMLElement>(`.${EMBED}`);
			if (embed) {
				this.schedule(embed);
				continue;
			}
			for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
				if (node.instanceOf(HTMLElement) && (node.hasClass(EMBED) || node.find(`.${EMBED}`))) {
					this.schedule(root);
					break;
				}
			}
		}
	}

	private schedule(el: HTMLElement): void {
		this.dirty.add(el);
		if (this.frame) return;
		this.frame = window.requestAnimationFrame(() => this.flush());
	}

	private flush(): void {
		this.frame = 0;
		this.walked = false;
		const embeds = new Set<HTMLElement>();
		for (const el of this.dirty) {
			if (!el.isConnected) continue;
			if (el.hasClass(EMBED)) embeds.add(el);
			else for (const embed of el.findAll(`.${EMBED}`)) embeds.add(embed);
		}
		this.dirty.clear();
		for (const embed of embeds) this.paint(embed);
		this.walked = false;
		this.prune();
	}

	/** Show the formats of an embedded table, and give it the table tools. */
	private paint(el: HTMLElement): void {
		const host = this.resolve(el);
		if (!host) return;
		const shown = host.shownView();
		if (shown.type !== 'table' || !shown.name) {
			this.cells.clear(el);
			return;
		}
		this.listen(el);
		this.cells.decorate(host.owner, el, host.format(shown.name));
	}

	/**
	 * The host of an embed: known, or found by walking the workspace (once per paint). An embed
	 * whose controller cannot be found is tried again later; `now` (the user acts on it) tries at once.
	 */
	private resolve(el: HTMLElement, now = false): EmbedTable | null {
		const known = this.hosts.get(el);
		if (known?.alive()) return known;
		const missed = this.misses.get(el);
		if (!now && missed && Date.now() - missed.at < missed.wait) return null;
		if (now || !this.walked) this.walk();
		const found = this.hosts.get(el);
		if (found?.alive()) {
			this.misses.delete(el);
			return found;
		}
		const wait = missed ? Math.min(RETRY_MAX_MS, missed.wait * 2) : RETRY_MS;
		this.misses.set(el, { at: Date.now(), wait });
		const timer = window.setTimeout(() => {
			this.retries.delete(timer);
			if (el.isConnected) this.schedule(el);
		}, wait);
		this.retries.add(timer);
		return null;
	}

	/** Look for the controllers of every embed on screen, from the workspace leaves down. */
	private walk(): void {
		this.walked = true;
		const roots: unknown[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			roots.push(leaf, leaf.view);
		});
		for (const [el, controller] of findEmbedControllers(roots)) {
			const known = this.hosts.get(el);
			if (known?.owns(controller)) continue;
			this.hosts.set(el, new EmbedTable(this.plugin, el, controller, (root) => this.schedule(root)));
		}
	}

	/** The listeners a Bases leaf's table has, on one embed: removed again when the embed goes. */
	private listen(el: HTMLElement): void {
		if (this.listening.has(el)) return;
		const stop = new AbortController();
		this.listening.set(el, stop);
		const { signal } = stop;
		const used = () => {
			this.lastUsed = new WeakRef(el);
		};
		el.addEventListener('pointerdown', used, { signal, capture: true });
		el.addEventListener('focusin', used, { signal });
		// The menu items are added after Bases' own handlers (bubbling), the double-click and the
		// row line handle come first (capture).
		el.addEventListener('contextmenu', (event) => {
			used();
			this.cells.noteRightClick(event, el);
		}, { signal, capture: true });
		el.addEventListener('contextmenu', (event) => this.cells.onContextMenu(event, el), { signal });
		if (Platform.isMobile) el.addEventListener('click', (event) => this.cells.onTap(event, el), { signal });
		el.addEventListener('dblclick', (event) => this.cells.onDoubleClick(event, el), { signal, capture: true });
		el.addEventListener('pointerdown', (event) => this.cells.onPointerDown(event, el), { signal, capture: true });
		el.addEventListener('click', (event) => this.cells.onClick(event), { signal, capture: true });
		el.addEventListener('pointermove', (event) => this.cells.onPointerMove(event, el), { signal, passive: true });
		el.addEventListener('pointerleave', () => this.cells.onPointerLeave(el), { signal });
	}

	/** Drop the listeners of embeds that are no longer on screen (they come back when it is). */
	private prune(): void {
		let gone = false;
		for (const [el, stop] of this.listening) {
			if (el.isConnected) continue;
			stop.abort();
			this.listening.delete(el);
			gone = true;
		}
		if (gone) closeFormatPanelIfGone();
	}
}
