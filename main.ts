import { FileView, normalizePath, Notice, parseYaml, Platform, Plugin, stringifyYaml, TFile } from 'obsidian';
import {
	applyLook, carryThumbnails, disable, enable, findThumbnailFormula, fitTableColumns, isEnabled, isRecord, listPixelsFor, readLook, setViewThumbnails, summarizeViews, thumbnailAspect, updateView,
	type BaseLook, type ViewSummary,
} from './src/baseConfig.ts';
import { addGroupValue, autoColors, groupNoteProperty, normalizeHex, readGroupColors, readGroupStyle, renameGroupValue, writeGroupColors, writeGroupStyle, type GroupStyle } from './src/groups.ts';
import { base64ToBytes, detectImage, firstWebUrl, IMAGE_EXTENSIONS, isHostedOn, parseImageInput, youtubeId, youtubeWatchUrl } from './src/images.ts';
import { strings } from './src/i18n';
import { ThumbnailModal } from './src/modal';
import { GroupMenuExtension } from './src/groupMenu';
import { kanbanViewsNeedingGroup, pickGroupProperty, setViewGroupBy } from './src/kanban.ts';
import { readGroupFiles } from './src/native';
import { BasesOverlay } from './src/overlay';
import { readLocalFile, Remote, RemoteError, type EagleClient, type EagleItem, type ImageData } from './src/remote';
import { defaultSettings, ThumbnailSettingTab, type Storage, type ThumbnailSettings } from './src/settings';
import { linkValue, readThumbnail, saveImageToVault, writeThumbnail } from './src/storage';

export type ThumbnailSource =
	| { kind: 'file'; file: File }
	| { kind: 'url'; url: string }
	/** An image that is already in the vault. */
	| { kind: 'vault'; file: TFile }
	/** A file on this computer, outside the vault. Desktop only. */
	| { kind: 'local'; path: string }
	| { kind: 'data'; mime: string; base64: string }
	| { kind: 'eagle'; item: EagleItem; client: EagleClient };

/** What a typed or pasted thumbnail input turned out to be, for the hint under the address field. */
export interface InputCheck {
	source: ThumbnailSource | null;
	kind: 'empty' | 'web' | 'youtube' | 'hosted' | 'vault' | 'local' | 'data' | 'missing' | 'not-image' | 'desktop-only' | 'unknown';
	/** File path or name to show in the hint. */
	detail: string;
}

export interface BaseInfo {
	enabled: boolean;
	/** Name of the formula that renders thumbnails in tables and lists. */
	formula: string | null;
	look: BaseLook;
	/** Height ÷ width of thumbnails in table and list views. */
	aspect: number;
	/** Every view of the base, for the look panel. */
	views: ViewSummary[];
	/** Group value → #RRGGBB, stored in the base file. */
	groupColors: Record<string, string>;
	/** Per-base overrides of the group look. */
	groupStyle: Partial<GroupStyle>;
}


const BODY_CLASSES = [
	'achmage-look-tidy',
	'achmage-look-hover-lift',
	'achmage-look-hover-rows',
];

export default class AchmageBasesLookPlugin extends Plugin {
	override settings: ThumbnailSettings = defaultSettings();
	remote!: Remote;
	private overlay!: BasesOverlay;
	private groupMenu!: GroupMenuExtension;
	private readonly baseCache = new Map<string, { mtime: number; info: BaseInfo | null }>();
	private readonly baseLoading = new Set<string>();
	/** Kanban views this session already tried to group automatically (`path` + `view name`). */
	private readonly kanbanTried = new Set<string>();

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.remote = new Remote(this.app, () => this.settings);
		this.overlay = new BasesOverlay(this);
		this.groupMenu = new GroupMenuExtension(this);
		this.groupMenu.watch(document);
		this.addSettingTab(new ThumbnailSettingTab(this));
		this.applyBodyClasses(document.body);

		const t = strings();
		this.addCommand({
			id: 'add-thumbnail',
			name: t.cmdAdd,
			icon: 'image-plus',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) this.openThumbnailModal(file);
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-base-thumbnails',
			name: t.cmdToggle,
			icon: 'image',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'base') return false;
				if (!checking) void this.toggleBase(file);
				return true;
			},
		});

		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile)) return;
			if (file.extension === 'md') {
				menu.addItem((item) => item.setTitle(t.fileMenuAdd).setIcon('image-plus').setSection('action')
					.onClick(() => this.openThumbnailModal(file)));
			} else if (file.extension === 'base') {
				const enabled = this.baseInfo(file)?.enabled ?? false;
				menu.addItem((item) => item.setTitle(enabled ? t.fileMenuHide : t.fileMenuShow).setIcon('image').setSection('action')
					.onClick(() => void this.toggleBase(file)));
			}
		}));

		this.registerEvent(this.app.workspace.on('layout-change', () => this.overlay.attachAll()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.overlay.attachAll()));
		this.registerEvent(this.app.workspace.on('window-open', (win) => {
			this.applyBodyClasses(win.doc.body);
			this.groupMenu.watch(win.doc);
		}));
		this.registerEvent(this.app.metadataCache.on('changed', () => this.overlay.refreshAll()));
		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (file instanceof TFile && file.extension === 'base') {
				void this.followLayoutChanges(file);
				this.overlay.refreshAll();
				this.groupMenu.refresh();
			}
		}));
		this.app.workspace.onLayoutReady(() => {
			this.overlay.attachAll();
			void this.checkCmdsEagle();
		});
	}

	override onunload(): void {
		this.overlay.destroy();
		this.groupMenu.destroy();
		document.body.removeClasses(BODY_CLASSES);
		document.body.setCssProps({ '--achmage-look-list-size': '', '--achmage-look-hover-color': '' });
	}

	private async loadSettings(): Promise<void> {
		const stored: unknown = await this.loadData();
		const defaults = defaultSettings();
		const merged: Record<string, unknown> = { ...defaults };
		if (isRecord(stored)) {
			for (const [key, value] of Object.entries(stored)) {
				if (key in defaults && typeof value === typeof defaults[key as keyof ThumbnailSettings]) merged[key] = value;
			}
		}
		this.settings = merged as unknown as ThumbnailSettings;
	}

	async updateSetting(key: keyof ThumbnailSettings, value: unknown): Promise<void> {
		const defaults = defaultSettings();
		if (typeof value !== typeof defaults[key]) return;
		let clean = typeof value === 'string' ? value.trim() : value;
		// Same clean-up as the CMDS Eagle plugin: the Worker URL gets https:// and no trailing slash.
		if (key === 'r2WorkerUrl' && typeof clean === 'string' && clean) clean = (clean.startsWith('http') ? clean : `https://${clean}`).replace(/\/$/, '');
		if (key === 'r2PublicUrl' && typeof clean === 'string') clean = clean.replace(/\/$/, '');
		const next: Record<string, unknown> = { ...this.settings, [key]: clean };
		if (key === 'property' && !String(next.property)) return;
		if (key === 'kanbanGroupProperty' && !String(next.kanbanGroupProperty)) return;
		this.settings = next as unknown as ThumbnailSettings;
		await this.saveData(this.settings);
		if (key === 'property') this.baseCache.clear();
		this.applyBodyClasses(document.body);
		this.overlay.refreshAll();
	}

	private applyBodyClasses(body: HTMLElement): void {
		const s = this.settings;
		body.toggleClass('achmage-look-tidy', s.tidyImages);
		body.toggleClass('achmage-look-hover-lift', s.hoverLift);
		body.toggleClass('achmage-look-hover-rows', s.hoverRows);
		body.setCssProps({
			'--achmage-look-hover-color': s.hoverUseAccent ? 'var(--interactive-accent)' : (normalizeHex(s.hoverColor) ?? 'var(--interactive-accent)'),
		});
		body.setCssProps({ '--achmage-look-list-size': `${listPixelsFor(this.settings.listSize)}px` });
	}

	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	openThumbnailModal(note: TFile): void {
		new ThumbnailModal(this, note).open();
	}

	hasThumbnail(note: TFile): boolean {
		return readThumbnail(this.app, note, this.settings.property) !== null;
	}

	// ---- .base files -------------------------------------------------------------------

	private parseBase(text: string): Record<string, unknown> | null {
		try {
			const parsed: unknown = text.trim() ? parseYaml(text) : {};
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	private describe(base: Record<string, unknown>): BaseInfo {
		const property = this.settings.property;
		return {
			enabled: isEnabled(base, property),
			formula: findThumbnailFormula(base, property),
			look: readLook(base, property),
			aspect: thumbnailAspect(base, property),
			views: summarizeViews(base, property),
			groupColors: readGroupColors(base),
			groupStyle: readGroupStyle(base),
		};
	}

	/**
	 * Cached facts about a base file. Returns the last known answer at once and refreshes
	 * in the background when the file changed; `onReady` runs after a refresh.
	 */
	baseInfo(file: TFile, onReady?: () => void): BaseInfo | null {
		const cached = this.baseCache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) return cached.info;
		if (!this.baseLoading.has(file.path)) {
			this.baseLoading.add(file.path);
			void this.app.vault.cachedRead(file).then((text) => {
				const base = this.parseBase(text);
				const info = base ? this.describe(base) : null;
				this.baseCache.set(file.path, { mtime: file.stat.mtime, info });
				if (info) void this.autoGroupKanban(file, cached?.info ?? null, info);
			}).finally(() => {
				this.baseLoading.delete(file.path);
				onReady?.();
			});
		}
		return cached?.info ?? null;
	}

	private async editBase(file: TFile, change: (base: Record<string, unknown>) => void): Promise<BaseInfo | null> {
		let info: BaseInfo | null = null;
		await this.app.vault.process(file, (text) => {
			const base = this.parseBase(text);
			if (!base) throw new Error('unreadable base');
			change(base);
			info = this.describe(base);
			return stringifyYaml(base);
		});
		// Keep the new facts cached so the toolbar does not flicker to “off” while Bases reloads the file.
		this.baseCache.set(file.path, { mtime: file.stat.mtime, info });
		this.overlay.refreshAll();
		return info;
	}

	async toggleBase(file: TFile): Promise<void> {
		const t = strings();
		const property = this.settings.property;
		try {
			const base = this.parseBase(await this.app.vault.read(file));
			if (!base) throw new Error('unreadable base');
			const turnOn = !isEnabled(base, property);
			const info = await this.editBase(file, (draft) => {
				if (turnOn) enable(draft, property, { size: null, ratio: this.settings.defaultRatio, fit: null });
				else disable(draft, property);
			});
			if (turnOn && !info?.enabled) new Notice(t.baseNoViews);
			else new Notice(turnOn ? t.baseShown(file.basename) : t.baseHidden(file.basename));
		} catch {
			new Notice(t.baseUnreadable);
		}
	}

	/** Change size, shape or fit of every thumbnail view in the base. The size also sets the list size. */
	async setLook(file: TFile, look: Partial<BaseLook>): Promise<BaseInfo | null> {
		try {
			if (typeof look.size === 'number') await this.updateSetting('listSize', look.size);
			return await this.editBase(file, (draft) => applyLook(draft, this.settings.property, look));
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	emptyBaseInfo(): BaseInfo {
		return { enabled: false, formula: null, look: { size: null, ratio: null, fit: null }, aspect: 1, views: [], groupColors: {}, groupStyle: {} };
	}

	/** The group look of a base: its own overrides on top of the plugin settings. */
	effectiveGroupStyle(info: BaseInfo | null): GroupStyle {
		const s = this.settings;
		return { background: s.groupBackground, tint: s.groupTint, border: s.groupBorder, heading: s.groupHeading, ...(info?.groupStyle ?? {}) };
	}

	async setGroupStyle(file: TFile, changes: Partial<GroupStyle>): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => writeGroupStyle(draft, changes));
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Change settings of one view (layout, column width, card size, row height, image fit or ratio). */
	async setViewOptions(file: TFile, viewName: string, changes: Record<string, unknown>): Promise<BaseInfo | null> {
		const property = this.settings.property;
		try {
			return await this.editBase(file, (draft) => {
				const before = summarizeViews(draft, property).find((view) => view.name === viewName);
				updateView(draft, viewName, changes);
				// A new layout keeps the thumbnails the view had.
				if (before?.thumbnails && typeof changes.type === 'string' && changes.type !== before.type) carryThumbnails(draft, property, [viewName]);
				fitTableColumns(draft, property);
			});
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/**
	 * After the base file changed, move thumbnails along with any view whose layout was changed
	 * in Obsidian's own view settings. Compares with the last known state of the file, so views
	 * whose thumbnails were turned off stay off.
	 */
	private async followLayoutChanges(file: TFile): Promise<void> {
		const known = this.baseCache.get(file.path)?.info;
		if (!known?.enabled) return;
		const property = this.settings.property;
		try {
			const base = this.parseBase(await this.app.vault.read(file));
			if (!base) return;
			const types = new Map(known.views.filter((view) => view.thumbnails).map((view) => [view.name, view.type]));
			const moved = summarizeViews(base, property)
				.filter((view) => types.has(view.name) && types.get(view.name) !== view.type && !view.thumbnails)
				.map((view) => view.name);
			if (moved.length === 0 || !carryThumbnails(base, property, moved)) return;
			await this.editBase(file, (draft) => {
				carryThumbnails(draft, property, moved);
				fitTableColumns(draft, property);
			});
		} catch {
			// The view still works; only the thumbnails stay where Obsidian left them.
		}
	}

	/**
	 * A kanban view without a group property shows only Obsidian's “Choose a property”. Group it
	 * so its notes show at once (under “None” while they have no value). Skipped when the user
	 * has just removed the grouping, or turned this off in the settings.
	 */
	private async autoGroupKanban(file: TFile, previous: BaseInfo | null, info: BaseInfo): Promise<void> {
		if (!this.settings.autoKanbanGroup) return;
		const views = kanbanViewsNeedingGroup(info.views, previous?.views ?? null)
			.filter((name) => !this.kanbanTried.has(`${file.path}\n${name}`));
		if (views.length === 0) return;
		for (const name of views) this.kanbanTried.add(`${file.path}\n${name}`);
		const property = this.kanbanGroupPropertyFor(file);
		try {
			await this.editBase(file, (draft) => {
				for (const name of views) setViewGroupBy(draft, name, property);
			});
			new Notice(strings().kanbanGrouped(property));
		} catch {
			// The view keeps Obsidian's own “Choose a property”.
		}
	}

	/** Group a kanban view by hand, from the button next to Obsidian's “Choose a property”. */
	async groupKanbanView(file: TFile, viewName: string): Promise<BaseInfo | null> {
		const property = this.kanbanGroupPropertyFor(file);
		try {
			const info = await this.editBase(file, (draft) => setViewGroupBy(draft, viewName, property));
			new Notice(strings().kanbanGrouped(property));
			return info;
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Group property for a kanban view of this base: a status property the notes use, else the setting. */
	kanbanGroupPropertyFor(file: TFile): string {
		const notes = new Set<TFile>();
		for (const leaf of this.app.workspace.getLeavesOfType('bases')) {
			if (!(leaf.view instanceof FileView) || leaf.view.file !== file) continue;
			for (const group of readGroupFiles(leaf.view)?.values() ?? []) group.forEach((note) => notes.add(note));
		}
		const frontmatters = [...notes].map((note) => this.app.metadataCache.getFileCache(note)?.frontmatter);
		return pickGroupProperty(frontmatters, this.settings.kanbanGroupProperty);
	}

	async setViewThumbnails(file: TFile, viewName: string, on: boolean): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => fitTableColumns(setViewThumbnails(draft, viewName, this.settings.property, on), this.settings.property));
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Set or clear (null) group colors in the base file. */
	async setGroupColors(file: TFile, changes: Record<string, string | null>): Promise<BaseInfo | null> {
		try {
			return await this.editBase(file, (draft) => writeGroupColors(draft, changes));
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	// ---- group values ----------------------------------------------------------------------

	/** Notes per group (value as text, '' for no value) of the base view shown in this container. */
	groupFiles(root: HTMLElement): Map<string, TFile[]> | null {
		const leaf = this.app.workspace.getLeavesOfType('bases').find((each) => each.view.containerEl === root);
		return leaf ? readGroupFiles(leaf.view) : null;
	}

	/**
	 * Rename a group: every note in it gets the new value, and the base keeps the group's color
	 * and its place in views that order groups by hand. Values that are not text are left alone.
	 */
	async renameGroup(base: TFile, root: HTMLElement, property: string, from: string, to: string): Promise<BaseInfo | null> {
		const t = strings();
		const name = groupNoteProperty(property);
		const files = this.groupFiles(root)?.get(from) ?? null;
		if (!name || files === null) {
			new Notice(t.groupRenameUnsupported);
			return null;
		}
		let changed = 0;
		for (const file of files) {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				const value = frontmatter[name];
				if (typeof value === 'string' && value.trim() === from) {
					frontmatter[name] = to;
					changed++;
				} else if (Array.isArray(value) && value.includes(from)) {
					frontmatter[name] = value.map((item: unknown) => (item === from ? to : item)).filter((item, i, all) => all.indexOf(item) === i);
					changed++;
				}
			});
		}
		if (files.length > 0 && changed === 0) {
			new Notice(t.groupRenameNone);
			return null;
		}
		try {
			const info = await this.editBase(base, (draft) => renameGroupValue(draft, property, from, to));
			new Notice(t.groupRenameDone(from, to, changed));
			return info;
		} catch {
			new Notice(strings().baseUnreadable);
			return null;
		}
	}

	/** Add an empty group to a view (the view then orders its groups by hand). */
	async addGroup(base: TFile, root: HTMLElement, viewName: string, value: string): Promise<BaseInfo | null> {
		const t = strings();
		const groups = this.groupFiles(root);
		if (!groups) {
			new Notice(t.groupRenameUnsupported);
			return null;
		}
		if (groups.has(value)) {
			new Notice(t.groupAddExists(value));
			return null;
		}
		let added = false;
		try {
			const info = await this.editBase(base, (draft) => {
				added = addGroupValue(draft, viewName, value, [...groups.keys()]);
				// In a base that uses group colors, the new group gets the next free one.
				const colors = readGroupColors(draft);
				if (added && Object.keys(colors).length > 0 && !colors[value]) {
					writeGroupColors(draft, { [value]: autoColors([value], colors)[value] ?? null });
				}
			});
			new Notice(added ? t.groupAddDone(value) : t.groupAddExists(value));
			return info;
		} catch {
			new Notice(t.baseUnreadable);
			return null;
		}
	}

	// ---- adding images -------------------------------------------------------------------

	/**
	 * Work out what typed or pasted text points at: a web address (bare or inside Markdown or
	 * HTML), an image in the vault, a file on this computer, or embedded image data.
	 */
	checkInput(text: string, note: TFile | null): InputCheck {
		const parsed = parseImageInput(text);
		if (!parsed) return { source: null, kind: text.trim() ? 'unknown' : 'empty', detail: '' };
		if (parsed.kind === 'url') {
			if (youtubeId(parsed.url)) return { source: parsed, kind: 'youtube', detail: parsed.url };
			return { source: parsed, kind: isHostedOn(parsed.url, this.settings.r2PublicUrl) ? 'hosted' : 'web', detail: parsed.url };
		}
		if (parsed.kind === 'data') return { source: parsed, kind: 'data', detail: '' };
		if (parsed.kind === 'local') {
			return Platform.isDesktop
				? { source: parsed, kind: 'local', detail: parsed.path }
				: { source: null, kind: 'desktop-only', detail: parsed.path };
		}
		const linkpath = parsed.linkpath.trim();
		const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, note?.path ?? '')
			?? this.app.vault.getFileByPath(normalizePath(linkpath))
			// [[picture]] without its extension: look for an image of that name.
			?? this.app.vault.getFiles().find((each) => IMAGE_EXTENSIONS.includes(each.extension.toLowerCase())
				&& (each.basename === linkpath || each.path.slice(0, -each.extension.length - 1) === linkpath))
			?? null;
		const extension = /\.([a-z0-9]+)$/i.exec(linkpath)?.[1]?.toLowerCase() ?? '';
		if (!file) return { source: null, kind: IMAGE_EXTENSIONS.includes(extension) ? 'missing' : 'unknown', detail: linkpath };
		if (!IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())) return { source: null, kind: 'not-image', detail: file.path };
		return { source: { kind: 'vault', file }, kind: 'vault', detail: file.path };
	}

	/** Turn something dropped or pasted into a thumbnail source, or null if it holds no image. */
	sourceFromTransfer(transfer: DataTransfer, note: TFile | null = null): ThumbnailSource | null {
		const file = Array.from(transfer.files).find((each) => each.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(each.name));
		if (file) return { kind: 'file', file };
		const url = firstWebUrl(transfer.getData('text/uri-list'));
		if (url) return { kind: 'url', url };
		for (const text of [transfer.getData('text/plain'), transfer.getData('text/html')]) {
			const source = text ? this.checkInput(text, note).source : null;
			if (source) return source;
		}
		return null;
	}

	/** Dropped straight onto a card: use the default destination without asking. */
	async addFromDataTransfer(note: TFile, transfer: DataTransfer): Promise<void> {
		const source = this.sourceFromTransfer(transfer, note);
		if (!source) {
			new Notice(strings().notImage);
			return;
		}
		const storage = this.settings.defaultStorage === 'r2' && this.remote.r2Config() ? 'r2' : 'vault';
		await this.addThumbnail(note, source, storage);
	}

	private async readSource(source: ThumbnailSource): Promise<ImageData> {
		if (source.kind === 'url') return this.remote.download(source.url);
		if (source.kind === 'eagle') return source.client.read(source.item);
		let data: ArrayBuffer;
		let mime: string | undefined;
		let name: string;
		if (source.kind === 'vault') {
			data = await this.app.vault.readBinary(source.file);
			name = source.file.name;
		} else if (source.kind === 'local') {
			try {
				data = await readLocalFile(source.path);
			} catch {
				throw new RemoteError('local-file');
			}
			name = source.path.split(/[\\/]/).pop() || 'image';
		} else if (source.kind === 'data') {
			data = base64ToBytes(source.base64).slice().buffer;
			mime = source.mime;
			name = 'image';
		} else {
			data = await source.file.arrayBuffer();
			mime = source.file.type;
			name = source.file.name;
		}
		const type = detectImage(new Uint8Array(data), mime, name);
		if (!type) throw new RemoteError('not-image');
		return { ...type, data, name };
	}

	/** Store the image and write the note property. Returns false (after a notice) on failure. */
	async addThumbnail(note: TFile, source: ThumbnailSource, storage: Storage): Promise<boolean> {
		const t = strings();
		try {
			let value: string;
			const video = source.kind === 'url' ? youtubeId(source.url) : null;
			if (source.kind === 'url' && video) {
				// A YouTube video: its preview image is the thumbnail.
				const preview = await this.remote.youtubeThumbnail(video);
				value = storage === 'link' ? preview.url : await this.storeImage(note, preview.image, storage, null);
			} else if (source.kind === 'url' && (storage === 'link' || isHostedOn(source.url, this.settings.r2PublicUrl))) {
				// Link only, or an image already on Cloudflare R2: nothing to store again.
				value = source.url;
			} else if (source.kind === 'vault' && storage !== 'r2') {
				value = linkValue(this.app, source.file, note);
			} else {
				const image = await this.readSource(source);
				value = await this.storeImage(note, image, storage, source.kind === 'vault' ? source.file : null);
			}
			await writeThumbnail(this.app, note, this.settings.property, value);
			new Notice(t.added(note.basename));
			if (source.kind === 'url' && video && !(await this.writeVideoLink(note, youtubeWatchUrl(source.url, video)))) {
				new Notice(t.linkKept(this.settings.linkProperty.trim()));
			}
			return true;
		} catch (error) {
			const message = error instanceof RemoteError
				? error.message === 'not-image' ? t.notImage
					: error.message === 'download' ? t.downloadFailed(error.status)
						: error.message === 'r2-missing' ? t.r2Missing
							: error.message === 'local-file' ? t.localFailed
								: error.message.startsWith('eagle') ? t.eagleOffline
									: t.r2Failed(error.message)
				: error instanceof Error ? error.message : String(error);
			new Notice(message);
			return false;
		}
	}

	/**
	 * Save image data as the thumbnail: in the vault, or uploaded to Cloudflare R2 (with a vault
	 * copy when the settings ask for one, unless the image already is a vault file).
	 */
	private async storeImage(note: TFile, image: ImageData, storage: Storage, vaultFile: TFile | null): Promise<string> {
		if (storage !== 'r2') return linkValue(this.app, await saveImageToVault(this.app, this.settings.folder, note, image), note);
		const saved = this.settings.keepVaultCopy && !vaultFile ? await saveImageToVault(this.app, this.settings.folder, note, image) : null;
		return this.remote.uploadToR2(image, saved?.name ?? vaultFile?.name ?? `${note.basename}.${image.ext}`);
	}

	/**
	 * Keep the video address in the link property, so the ▶ button on the thumbnail opens it.
	 * Another address already there is left alone. Returns false in that case.
	 */
	private async writeVideoLink(note: TFile, url: string): Promise<boolean> {
		const property = this.settings.linkProperty.trim();
		if (!property) return true;
		let written = true;
		await this.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
			const current: unknown = frontmatter[property];
			const text = typeof current === 'string' ? current.trim() : '';
			const parsed = text ? parseImageInput(text) : null;
			// Empty, or another YouTube video: replace. Anything else belongs to the user.
			const replaceable = current === undefined || current === null || (typeof current === 'string' && (!text || (parsed?.kind === 'url' && youtubeId(parsed.url) !== null)));
			if (replaceable) frontmatter[property] = url;
			else written = false;
		});
		return written;
	}

	/** True when this vault has CMDS Eagle settings that hold a Cloudflare R2 worker. Set on load. */
	cmdsEagleFound = false;

	private cmdsEaglePath(): string {
		return `${this.app.vault.configDir}/plugins/cmds-eagle/data.json`;
	}

	private async readCmdsEagleR2(): Promise<{ workerUrl: string; apiKey: string; publicUrl: string } | null> {
		try {
			const data: unknown = JSON.parse(await this.app.vault.adapter.read(this.cmdsEaglePath()));
			const providers = isRecord(data) && isRecord(data.cloudProviders) ? data.cloudProviders : null;
			const r2 = providers && isRecord(providers.r2) ? providers.r2 : null;
			const pick = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
			const found = {
				workerUrl: pick(r2?.workerUrl) || (isRecord(data) ? pick(data.r2WorkerUrl) : ''),
				apiKey: pick(r2?.apiKey) || (isRecord(data) ? pick(data.r2ApiKey) : ''),
				publicUrl: pick(r2?.publicUrl) || (isRecord(data) ? pick(data.r2PublicUrl) : ''),
			};
			return found.workerUrl && found.apiKey ? found : null;
		} catch {
			return null;
		}
	}

	async checkCmdsEagle(): Promise<void> {
		this.cmdsEagleFound = (await this.readCmdsEagleR2()) !== null;
	}

	getR2ApiKey(): string {
		const id = this.settings.r2ApiKeySecret;
		return id ? (this.app.secretStorage.getSecret(id) ?? '') : '';
	}

	/** Keep the API key in Obsidian's secret storage; the settings file only holds its id. */
	async setR2ApiKey(value: string): Promise<void> {
		const id = this.settings.r2ApiKeySecret || 'achmage-bases-look-r2-api-key';
		this.app.secretStorage.setSecret(id, value.trim());
		if (this.settings.r2ApiKeySecret !== id) {
			this.settings = { ...this.settings, r2ApiKeySecret: id };
			await this.saveData(this.settings);
		}
	}

	/** Copy the Cloudflare R2 worker settings from the CMDS Eagle plugin. The key goes to secret storage. */
	async importCmdsEagle(): Promise<boolean> {
		const found = await this.readCmdsEagleR2();
		if (!found) return false;
		const secretId = this.settings.r2ApiKeySecret || 'achmage-bases-look-r2-api-key';
		this.app.secretStorage.setSecret(secretId, found.apiKey);
		this.settings = { ...this.settings, r2WorkerUrl: found.workerUrl, r2PublicUrl: found.publicUrl, r2ApiKeySecret: secretId };
		await this.saveData(this.settings);
		return true;
	}

	async removeThumbnail(note: TFile): Promise<void> {
		await writeThumbnail(this.app, note, this.settings.property, null);
		new Notice(strings().removed(note.basename));
	}
}
