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
