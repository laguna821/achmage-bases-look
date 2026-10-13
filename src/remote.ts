import { Platform, requestUrl, type App } from 'obsidian';
import { buildMultipart, detectImage, IMAGE_EXTENSIONS, isWebUrl, resourcePathPart, type ImageType } from './images.ts';
import type { ThumbnailSettings } from './settings';

export interface ImageData extends ImageType {
	data: ArrayBuffer;
	/** Name to use in messages and as an upload file name hint. */
	name: string;
}

export interface EagleItem {
	id: string;
	name: string;
	ext: string;
	noThumbnail: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function trimSlash(url: string): string {
	return url.trim().replace(/\/+$/, '');
}

export class RemoteError extends Error {
	readonly status: number;
	constructor(message: string, status = 0) {
		super(message);
		this.status = status;
	}
}

/** Desktop resource URL for a file outside the vault, e.g. one in the Eagle library. */
export function localFileUrl(absolutePath: string): string {
	return Platform.resourcePathPrefix + resourcePathPart(absolutePath);
}

export class Remote {
	private readonly app: App;
	private readonly settings: () => ThumbnailSettings;

	constructor(app: App, settings: () => ThumbnailSettings) {
		this.app = app;
		this.settings = settings;
	}

	/** Download an image from the web. Throws RemoteError when it fails or is not an image. */
	async download(url: string): Promise<ImageData> {
		const response = await requestUrl({ url, throw: false });
		if (response.status >= 400) throw new RemoteError('download', response.status);
		const type = detectImage(new Uint8Array(response.arrayBuffer), response.headers['content-type'], url);
		if (!type) throw new RemoteError('not-image');
		const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
		return { ...type, data: response.arrayBuffer, name };
	}

	/** Worker settings, or null until the Worker URL and API key are both set. */
	r2Config(): { workerUrl: string; apiKey: string; publicUrl: string } | null {
		const s = this.settings();
		const apiKey = s.r2ApiKeySecret ? this.app.secretStorage.getSecret(s.r2ApiKeySecret) : null;
		if (!s.r2WorkerUrl.trim() || !apiKey) return null;
		return { workerUrl: trimSlash(s.r2WorkerUrl), apiKey, publicUrl: trimSlash(s.r2PublicUrl) };
	}

	/** Upload through the CMDS Eagle style worker (POST /upload, Bearer key) and return the public URL. */
	async uploadToR2(image: ImageData, fileName: string): Promise<string> {
		const config = this.r2Config();
		if (!config) throw new RemoteError('r2-missing');
		const boundary = `----BasesThumbnails${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		const body = buildMultipart(
			{ filename: fileName, content_type: image.mime },
			{ field: 'file', filename: fileName, mime: image.mime, data: new Uint8Array(image.data) },
			boundary,
		);
		const response = await requestUrl({
			url: `${config.workerUrl}/upload`,
			method: 'POST',
			headers: { Authorization: `Bearer ${config.apiKey}` },
			contentType: `multipart/form-data; boundary=${boundary}`,
			body,
			throw: false,
		});
		if (response.status >= 300) throw new RemoteError(`${response.status} ${response.text.slice(0, 120)}`, response.status);
		const result: unknown = response.json;
		if (!isRecord(result) || typeof result.key !== 'string') throw new RemoteError('unexpected worker response');
		// Same as CMDS Eagle: the note gets Public URL + "/" + key.
		if (config.publicUrl) return `${config.publicUrl}/${result.key}`;
		// Without a Public URL, use the address the worker reports, if any.
		const reported = [result.publicUrl, result.url].find((value): value is string => typeof value === 'string' && isWebUrl(value));
		if (reported) return reported;
		throw new RemoteError('set the Public URL');
	}

	async testR2(): Promise<boolean> {
		const config = this.r2Config();
		if (!config) return false;
		try {
			const response = await requestUrl({
				url: `${config.workerUrl}/health`,
				headers: { Authorization: `Bearer ${config.apiKey}` },
				throw: false,
			});
			return response.status === 200;
		} catch {
			return false;
		}
	}

	eagle(): EagleClient {
		return new EagleClient(trimSlash(this.settings().eagleUrl || 'http://localhost:41595'));
	}
}

/** Minimal client for the Eagle app's local API. */
export class EagleClient {
	private readonly baseUrl: string;
	private libraryPath: string | null = null;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	private async get(path: string): Promise<unknown> {
		const response = await requestUrl({ url: `${this.baseUrl}${path}`, throw: false });
		if (response.status !== 200) throw new RemoteError('eagle', response.status);
		const json: unknown = response.json;
		if (!isRecord(json) || json.status !== 'success') throw new RemoteError('eagle');
		return json.data;
	}

	async ping(): Promise<boolean> {
		try {
			await this.get('/api/application/info');
			return true;
		} catch {
			return false;
		}
	}

	async search(keyword: string, limit = 60): Promise<EagleItem[]> {
		const params = new URLSearchParams({ limit: String(limit), orderBy: '-CREATEDATE' });
		if (keyword.trim()) params.set('keyword', keyword.trim());
		const data = await this.get(`/api/item/list?${params.toString()}`);
		if (!Array.isArray(data)) return [];
		const items: EagleItem[] = [];
		for (const raw of data) {
			if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || typeof raw.ext !== 'string') continue;
			if (!IMAGE_EXTENSIONS.includes(raw.ext.toLowerCase())) continue;
			items.push({ id: raw.id, name: raw.name, ext: raw.ext, noThumbnail: raw.noThumbnail === true });
		}
		return items;
	}

	private async library(): Promise<string> {
		if (this.libraryPath) return this.libraryPath;
		const data = await this.get('/api/library/info');
		const library = isRecord(data) && isRecord(data.library) ? data.library : null;
		if (!library || typeof library.path !== 'string') throw new RemoteError('eagle');
		this.libraryPath = library.path;
		return library.path;
	}

	async filePath(item: EagleItem): Promise<string> {
		return `${await this.library()}/images/${item.id}.info/${item.name}.${item.ext}`;
	}

	async thumbnailPath(item: EagleItem): Promise<string> {
		const base = `${await this.library()}/images/${item.id}.info/${item.name}`;
		return item.noThumbnail ? `${base}.${item.ext}` : `${base}_thumbnail.png`;
	}

	/** Read the original image file of an item. Desktop only. */
	async read(item: EagleItem): Promise<ImageData> {
		const data = await readLocalFile(await this.filePath(item));
		const type = detectImage(new Uint8Array(data), undefined, `${item.name}.${item.ext}`);
		if (!type) throw new RemoteError('not-image');
		return { ...type, data, name: item.name };
	}
}

/** Read a file outside the vault (the Eagle library). Only possible in the desktop app. */
async function readLocalFile(path: string): Promise<ArrayBuffer> {
	if (Platform.isDesktop) {
		const { readFile } = await import('node:fs/promises');
		const buffer = await readFile(path);
		const copy = new Uint8Array(buffer.byteLength);
		copy.set(buffer);
		return copy.buffer;
	}
	throw new RemoteError('eagle-file');
}
