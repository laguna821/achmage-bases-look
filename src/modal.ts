import { debounce, Modal, Notice, Platform, setIcon, type TFile } from 'obsidian';
import { isWebUrl } from './images.ts';
import { strings } from './i18n';
import { localFileUrl, type EagleItem } from './remote';
import type { Storage } from './settings';
import { previewSource, readThumbnail } from './storage';
import type AchmageBasesLookPlugin from '../main';

export class ThumbnailModal extends Modal {
	private readonly plugin: AchmageBasesLookPlugin;
	private readonly note: TFile;
	private storage: Storage;
	private busy = false;
	private statusEl: HTMLElement | null = null;

	constructor(plugin: AchmageBasesLookPlugin, note: TFile) {
		super(plugin.app);
		this.plugin = plugin;
		this.note = note;
		const preferred = plugin.settings.defaultStorage;
		this.storage = preferred === 'r2' && !plugin.remote.r2Config() ? 'vault' : preferred;
	}

	override onOpen(): void {
		const t = strings();
		this.modalEl.addClass('achmage-look-modal');
		this.setTitle(t.modalTitle(this.note.basename));
		const { contentEl } = this;
		contentEl.empty();

		this.renderCurrent(contentEl);
		if (this.plugin.settings.askStorage) this.renderStorageChoice(contentEl);

		const input = contentEl.createEl('input', { type: 'file', attr: { accept: 'image/*', hidden: '' } });
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			if (file) void this.fromFile(file);
		});
		const drop = contentEl.createDiv({ cls: 'achmage-look-dropzone', attr: { role: 'button', tabindex: '0' } });
		setIcon(drop.createDiv({ cls: 'achmage-look-dropzone-icon' }), 'image-plus');
		drop.createDiv({ text: t.dropzone });
		drop.addEventListener('click', () => input.click());
		drop.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				input.click();
			}
		});
		drop.addEventListener('dragover', (event) => {
			event.preventDefault();
			drop.addClass('is-dragover');
		});
		drop.addEventListener('dragleave', () => drop.removeClass('is-dragover'));
		drop.addEventListener('drop', (event) => {
			event.preventDefault();
			drop.removeClass('is-dragover');
			if (event.dataTransfer) void this.fromTransfer(event.dataTransfer);
		});
		this.modalEl.addEventListener('paste', (event) => {
			if (event.clipboardData) {
				event.preventDefault();
				void this.fromTransfer(event.clipboardData);
			}
		});

		const urlRow = contentEl.createDiv({ cls: 'achmage-look-url-row' });
		const urlInput = urlRow.createEl('input', { type: 'url', placeholder: t.urlPlaceholder });
		const urlButton = urlRow.createEl('button', { text: t.urlAdd, cls: 'mod-cta' });
		const submitUrl = () => {
			const url = urlInput.value.trim();
			if (isWebUrl(url)) void this.run({ kind: 'url', url });
		};
		urlButton.addEventListener('click', submitUrl);
		urlInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') submitUrl();
		});

		if (Platform.isDesktopApp && this.plugin.settings.eagleEnabled) this.renderEagle(contentEl);
		this.statusEl = contentEl.createDiv({ cls: 'achmage-look-status' });
		window.setTimeout(() => drop.focus(), 0);
	}

	override onClose(): void {
		this.contentEl.empty();
	}

	private renderCurrent(parent: HTMLElement): void {
		const t = strings();
		const value = readThumbnail(this.app, this.note, this.plugin.settings.property);
		if (!value) return;
		const row = parent.createDiv({ cls: 'achmage-look-current' });
		const src = previewSource(this.app, this.note, value);
		if (src) row.createEl('img', { attr: { src, alt: t.current } });
		const side = row.createDiv({ cls: 'achmage-look-current-side' });
		side.createDiv({ cls: 'achmage-look-current-label', text: t.current });
		side.createDiv({ cls: 'achmage-look-current-value', text: value });
		const remove = side.createEl('button', { text: t.remove, cls: 'mod-warning' });
		remove.addEventListener('click', () => {
			void this.plugin.removeThumbnail(this.note).then(() => this.close());
		});
	}

	private renderStorageChoice(parent: HTMLElement): void {
		const t = strings();
		const row = parent.createDiv({ cls: 'achmage-look-storage' });
		row.createSpan({ cls: 'achmage-look-storage-label', text: t.saveTo });
		const group = row.createDiv({ cls: 'achmage-look-segments', attr: { role: 'radiogroup', 'aria-label': t.saveTo } });
		const options: { value: Storage; label: string; disabled: boolean }[] = [
			{ value: 'vault', label: t.storeVault, disabled: false },
			{ value: 'r2', label: t.storeR2, disabled: !this.plugin.remote.r2Config() },
			{ value: 'link', label: t.storeLink, disabled: false },
		];
		const hint = parent.createDiv({ cls: 'achmage-look-storage-hint' });
		const buttons: HTMLButtonElement[] = [];
		const select = (value: Storage) => {
			this.storage = value;
			buttons.forEach((button) => {
				const on = button.dataset.value === value;
				button.toggleClass('is-active', on);
				button.setAttribute('aria-checked', String(on));
			});
			hint.setText(value === 'link' ? t.storeLinkHint : value === 'r2' && this.plugin.settings.keepVaultCopy ? t.keepCopyDesc : '');
		};
		for (const option of options) {
			const button = group.createEl('button', { text: option.label, attr: { role: 'radio', 'data-value': option.value } });
			if (option.disabled) {
				button.disabled = true;
				button.setAttribute('aria-label', t.r2Missing);
			}
			button.addEventListener('click', () => select(option.value));
			buttons.push(button);
		}
		select(this.storage);
	}

	private renderEagle(parent: HTMLElement): void {
		const t = strings();
		const section = parent.createDiv({ cls: 'achmage-look-eagle' });
		const toggle = section.createEl('button', { cls: 'achmage-look-eagle-toggle' });
		setIcon(toggle.createSpan(), 'library');
		toggle.createSpan({ text: t.eagleButton });
		const panel = section.createDiv({ cls: 'achmage-look-eagle-panel' });
		panel.hide();
		const search = panel.createEl('input', { type: 'search', placeholder: t.eagleSearch });
		const grid = panel.createDiv({ cls: 'achmage-look-eagle-grid' });
		const client = this.plugin.remote.eagle();

		const load = async (keyword: string) => {
			grid.empty();
			let items: EagleItem[];
			try {
				items = await client.search(keyword);
			} catch {
				grid.createDiv({ cls: 'achmage-look-eagle-message', text: t.eagleOffline });
				return;
			}
			if (items.length === 0) {
				grid.createDiv({ cls: 'achmage-look-eagle-message', text: t.eagleEmpty });
				return;
			}
			for (const item of items) {
				const button = grid.createEl('button', { cls: 'achmage-look-eagle-item', attr: { 'aria-label': item.name, title: item.name } });
				const img = button.createEl('img', { attr: { alt: item.name, loading: 'lazy' } });
				void client.thumbnailPath(item).then((path) => {
					img.src = localFileUrl(path);
				});
				img.addEventListener('error', () => {
					void client.filePath(item).then((path) => {
						const original = localFileUrl(path);
						if (img.src !== original) img.src = original;
					});
				}, { once: true });
				button.addEventListener('click', () => {
					void this.run({ kind: 'eagle', item, client });
				});
			}
		};
		const reload = debounce((keyword: string) => void load(keyword), 300, true);
		search.addEventListener('input', () => reload(search.value));
		toggle.addEventListener('click', () => {
			if (panel.isShown()) {
				panel.hide();
				return;
			}
			panel.show();
			search.focus();
			void load(search.value);
		});
	}

	private async fromFile(file: File): Promise<void> {
		await this.run({ kind: 'file', file });
	}

	private async fromTransfer(transfer: DataTransfer): Promise<void> {
		const source = this.plugin.sourceFromTransfer(transfer);
		if (source) await this.run(source);
		else new Notice(strings().notImage);
	}

	private async run(source: Parameters<AchmageBasesLookPlugin['addThumbnail']>[1]): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.modalEl.addClass('is-busy');
		this.statusEl?.setText(strings().saving);
		const ok = await this.plugin.addThumbnail(this.note, source, this.storage);
		this.busy = false;
		this.modalEl.removeClass('is-busy');
		this.statusEl?.setText('');
		if (ok) this.close();
	}
}
