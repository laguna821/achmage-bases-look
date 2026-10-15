// Pure helpers for image bytes and names. No Obsidian imports, so the tests can run them in Node.

export interface ImageType {
	ext: string;
	mime: string;
}

const BY_EXT: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	avif: 'image/avif',
};

export const IMAGE_EXTENSIONS = Object.keys(BY_EXT);

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
	return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** Detect the image format from its first bytes. Returns null for anything that is not an image. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { ext: 'png', mime: 'image/png' };
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' };
	if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { ext: 'gif', mime: 'image/gif' };
	if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: 'webp', mime: 'image/webp' };
	if (startsWith(bytes, [0x42, 0x4d])) return { ext: 'bmp', mime: 'image/bmp' };
	if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69], 4)) return { ext: 'avif', mime: 'image/avif' };
	const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
	if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return { ext: 'svg', mime: 'image/svg+xml' };
	return null;
}

export function typeFromExtension(name: string): ImageType | null {
	const match = /\.([a-z0-9]+)(?:$|[?#])/i.exec(name);
	const ext = match?.[1]?.toLowerCase();
	if (!ext) return null;
	const mime = BY_EXT[ext];
	return mime ? { ext: ext === 'jpeg' ? 'jpg' : ext, mime } : null;
}

export function typeFromMime(mime: string | undefined): ImageType | null {
	const clean = mime?.split(';')[0]?.trim().toLowerCase();
	if (!clean) return null;
	const entry = Object.entries(BY_EXT).find(([, value]) => value === clean);
	return entry ? { ext: entry[0] === 'jpeg' ? 'jpg' : entry[0], mime: clean } : null;
}

/** Best guess of the image type: the bytes win, then the MIME type, then the name. */
export function detectImage(bytes: Uint8Array, mime?: string, name?: string): ImageType | null {
	return sniffImage(bytes) ?? typeFromMime(mime) ?? (name ? typeFromExtension(name) : null);
}

/** A file-name-safe version of a note name. */
export function safeName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, '-')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '');
	const short = Array.from(cleaned).slice(0, 60).join('').trim();
	return short || 'thumbnail';
}

export function timestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function thumbnailFileName(noteName: string, ext: string, date: Date): string {
	return `${safeName(noteName)}-${timestamp(date)}.${ext}`;
}

export function isWebUrl(value: string): boolean {
	return /^https?:\/\/\S+$/i.test(value.trim());
}

/** First web address in a dropped `text/uri-list` or plain text payload. */
export function firstWebUrl(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		const candidate = line.trim();
		if (candidate && !candidate.startsWith('#') && isWebUrl(candidate)) return candidate;
	}
	return null;
}

export interface MultipartFile {
	field: string;
	filename: string;
	mime: string;
	data: Uint8Array;
}

/** A multipart/form-data body, built by hand so it can go through `requestUrl` instead of `fetch`. */
export function buildMultipart(fields: Record<string, string>, file: MultipartFile, boundary: string): ArrayBuffer {
	const encoder = new TextEncoder();
	const quote = (value: string) => value.replace(/["\r\n]/g, '_');
	const parts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(fields)) {
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`));
	}
	parts.push(encoder.encode(
		`--${boundary}\r\nContent-Disposition: form-data; name="${quote(file.field)}"; filename="${quote(file.filename)}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
	));
	parts.push(file.data);
	parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));
	const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const body = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		body.set(part, offset);
		offset += part.byteLength;
	}
	return body.buffer;
}

/** Turn an absolute path from Eagle into the path part of a desktop resource URL. */
export function resourcePathPart(absolutePath: string): string {
	return absolutePath
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.split('/')
		.map((segment, i) => (i === 0 && /^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
		.join('/');
}

/** What a pasted or typed thumbnail input points at. */
export type ParsedInput =
	| { kind: 'url'; url: string }
	| { kind: 'vault'; linkpath: string }
	| { kind: 'local'; path: string }
	| { kind: 'data'; mime: string; base64: string };

const WRAPPERS = /^[\s"'`<]+|[\s"'`>]+$/g;
const TRAILING = /[.,;:!?)\]}>'"`]+$/;

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Work out what a thumbnail input means, whatever its form: a web address (bare, quoted or
 * inside Markdown or HTML), a vault link or path, an obsidian:// link, a local file path,
 * or a data: image. Returns null when nothing usable is found.
 */
export function parseImageInput(input: string): ParsedInput | null {
	const text = input.trim();
	if (!text) return null;

	const data = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(text.replace(WRAPPERS, ''));
	if (data?.[1] && data[2]) return { kind: 'data', mime: data[1].toLowerCase(), base64: data[2].replace(/\s+/g, '') };

	// Markdown image or link: ![alt](target "title") or [text](<target>)
	const markdown = /!?\[[^\]]*\]\(\s*<?([^)>]+?)>?(?:\s+["'][^"']*["'])?\s*\)/.exec(text);
	if (markdown?.[1]) return parseImageInput(markdown[1]);

	// Wiki embed or link: ![[file.png|200]] or [[folder/file.png#x]]
	const wiki = /!?\[\[([^\]|#^]+)(?:[|#^][^\]]*)?\]\]/.exec(text);
	if (wiki?.[1]) return { kind: 'vault', linkpath: wiki[1].trim() };

	// HTML image
	const html = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(text);
	if (html?.[1]) return parseImageInput(html[1].replace(/&amp;/g, '&'));

	const clean = text.replace(WRAPPERS, '');

	// obsidian://open?vault=…&file=…
	if (/^obsidian:\/\//i.test(clean)) {
		const file = /[?&]file=([^&]+)/.exec(clean)?.[1];
		return file ? { kind: 'vault', linkpath: decode(file.replace(/\+/g, ' ')) } : null;
	}

	// file:///C:/… or file:///Users/…
	if (/^file:\/\//i.test(clean)) {
		const path = decode(clean.replace(/^file:\/\/\/?/i, ''));
		return { kind: 'local', path: /^[a-z]:/i.test(path) ? path : `/${path.replace(/^\/+/, '')}` };
	}

	const web = /https?:\/\/[^\s<>"'`]+/i.exec(clean);
	if (web) return { kind: 'url', url: web[0].replace(TRAILING, '') };
	if (/^www\.[^\s/]+\.[^\s]+/i.test(clean)) return { kind: 'url', url: `https://${clean.replace(TRAILING, '')}` };

	// C:\…, \\server\share, /Users/…, ~/…
	if (/^[a-z]:[\\/]/i.test(clean) || /^\\\\/.test(clean) || /^~[\\/]/.test(clean) || (clean.startsWith('/') && clean.length > 1)) {
		return { kind: 'local', path: clean };
	}

	// Anything else is taken as a vault path or file name.
	if (/[\n\r]/.test(clean)) return null;
	return { kind: 'vault', linkpath: decode(clean) };
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** True when the address is already on the given public bucket address (or any r2.dev bucket). */
export function isHostedOn(url: string, publicUrl: string): boolean {
	const base = publicUrl.trim().replace(/\/+$/, '');
	if (base && url.startsWith(`${base}/`)) return true;
	return /^https:\/\/pub-[a-z0-9]+\.r2\.dev\//i.test(url);
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/** The video id of a YouTube address (watch, youtu.be, shorts, embed, live), or null. */
export function youtubeId(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	const host = parsed.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
	let id: string | null = null;
	if (host === 'youtu.be') {
		id = parsed.pathname.split('/')[1] ?? null;
	} else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
		id = parsed.pathname === '/watch'
			? parsed.searchParams.get('v')
			: /^\/(?:shorts|embed|live|v)\/([^/]+)/.exec(parsed.pathname)?.[1] ?? null;
	}
	return id && YOUTUBE_ID.test(id) ? id : null;
}

/** Preview images of a YouTube video, largest first; the largest is missing for some videos. */
export function youtubeThumbnails(id: string): string[] {
	return [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`];
}

/** A plain address that opens the video, keeping its start time. */
export function youtubeWatchUrl(url: string, id: string): string {
	let start: string | null = null;
	try {
		const params = new URL(url.trim()).searchParams;
		start = params.get('t') ?? params.get('start');
	} catch {
		start = null;
	}
	return `https://www.youtube.com/watch?v=${id}${start ? `&t=${encodeURIComponent(start)}` : ''}`;
}

/** First value of a frontmatter value as text (lists count by their first entry). */
function firstText(value: unknown): string | null {
	const first: unknown = Array.isArray(value) ? value[0] : value;
	return typeof first === 'string' && first.trim() ? first.trim() : null;
}

/** True when a frontmatter value points at an image: a web image, a vault image, or image data. */
export function looksLikeImage(value: unknown): boolean {
	const text = firstText(value);
	const parsed = text ? parseImageInput(text) : null;
	if (!parsed) return false;
	if (parsed.kind === 'data') return true;
	if (parsed.kind === 'url') return typeFromExtension(parsed.url) !== null || isHostedOn(parsed.url, '');
	return typeFromExtension(parsed.kind === 'vault' ? parsed.linkpath : parsed.path) !== null;
}

/** True when a frontmatter value is a web address. */
export function looksLikeWebLink(value: unknown): boolean {
	const text = firstText(value);
	return text ? parseImageInput(text)?.kind === 'url' : false;
}
