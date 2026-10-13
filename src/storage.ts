import { normalizePath, TFile, TFolder, type App } from 'obsidian';
import { isWebUrl, thumbnailFileName } from './images.ts';
import type { ImageData } from './remote';

async function ensureFolder(app: App, folder: string): Promise<void> {
	if (!folder || folder === '/') return;
	let current = '';
	for (const part of folder.split('/')) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFolder) continue;
		if (existing) throw new Error(`${current} is a file, not a folder`);
		await app.vault.createFolder(current);
	}
}

function availablePath(app: App, folder: string, fileName: string): string {
	const join = (name: string) => normalizePath(folder && folder !== '/' ? `${folder}/${name}` : name);
	const dot = fileName.lastIndexOf('.');
	const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
	const ext = dot > 0 ? fileName.slice(dot) : '';
	let candidate = join(fileName);
	for (let i = 2; app.vault.getAbstractFileByPath(candidate); i++) candidate = join(`${stem}-${i}${ext}`);
	return candidate;
}

/** Save image bytes into the image folder, named after the note. */
export async function saveImageToVault(app: App, folder: string, note: TFile, image: ImageData): Promise<TFile> {
	const target = normalizePath(folder.trim() || '/');
	await ensureFolder(app, target === '/' ? '' : target);
	const path = availablePath(app, target === '/' ? '' : target, thumbnailFileName(note.basename, image.ext, new Date()));
	return app.vault.createBinary(path, image.data);
}

/** The property value Bases understands for a vault image: a quoted wikilink. */
export function linkValue(app: App, image: TFile, note: TFile): string {
	return `[[${app.metadataCache.fileToLinktext(image, note.path, false)}]]`;
}

export async function writeThumbnail(app: App, note: TFile, property: string, value: string | null): Promise<void> {
	await app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
		if (value === null) delete frontmatter[property];
		else frontmatter[property] = value;
	});
}

/** Current raw value of the thumbnail property, or null when it is empty. */
export function readThumbnail(app: App, note: TFile, property: string): string | null {
	const raw: unknown = app.metadataCache.getFileCache(note)?.frontmatter?.[property];
	const value: unknown = Array.isArray(raw) ? raw[0] : raw;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** A URL an <img> can show for a property value, or null when it cannot be resolved. */
export function previewSource(app: App, note: TFile, value: string): string | null {
	if (isWebUrl(value)) return value;
	const match = /^!?\[\[([^\]|#]+)/.exec(value);
	const linkpath = match?.[1] ?? value;
	const file = app.metadataCache.getFirstLinkpathDest(linkpath.trim(), note.path);
	return file instanceof TFile ? app.vault.getResourcePath(file) : null;
}
