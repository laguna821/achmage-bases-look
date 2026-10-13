import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	sniffImage, detectImage, typeFromExtension, safeName, thumbnailFileName, buildMultipart, firstWebUrl, resourcePathPart,
} from '../src/images.ts';

test('sniffImage recognises common formats by their bytes', () => {
	assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))?.ext, 'png');
	assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))?.ext, 'jpg');
	assert.equal(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]))?.ext, 'gif');
	const webp = new Uint8Array(12);
	webp.set([0x52, 0x49, 0x46, 0x46], 0);
	webp.set([0x57, 0x45, 0x42, 0x50], 8);
	assert.equal(sniffImage(webp)?.ext, 'webp');
	assert.equal(sniffImage(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x"></svg>'))?.ext, 'svg');
	assert.equal(sniffImage(new TextEncoder().encode('<html>not an image</html>')), null);
});

test('detectImage falls back to the MIME type and then the name', () => {
	const unknown = new Uint8Array([1, 2, 3]);
	assert.equal(detectImage(unknown, 'image/webp; charset=x')?.ext, 'webp');
	assert.equal(detectImage(unknown, 'text/html', 'https://x.test/a/photo.JPEG?w=200')?.ext, 'jpg');
	assert.equal(detectImage(unknown, 'text/html', 'page.html'), null);
	assert.equal(typeFromExtension('poster.svg')?.mime, 'image/svg+xml');
});

test('safeName removes characters that break file names and links', () => {
	assert.equal(safeName('해리 포터: 마법사의 돌 #1 [특별판]'), '해리 포터- 마법사의 돌 -1 -특별판-');
	assert.equal(safeName('   '), 'thumbnail');
	assert.equal(safeName('..hidden'), 'hidden');
	assert.equal(Array.from(safeName('가'.repeat(100))).length, 60);
});

test('thumbnailFileName combines note name, time and extension', () => {
	assert.equal(thumbnailFileName('기생충', 'png', new Date(2026, 9, 13, 9, 5, 7)), '기생충-20261013-090507.png');
});

test('buildMultipart produces a body the R2 worker can parse', () => {
	const body = buildMultipart({ filename: 'a.png', content_type: 'image/png' }, { field: 'file', filename: 'a.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]) }, 'XYZ');
	const text = new TextDecoder('latin1').decode(new Uint8Array(body));
	assert.match(text, /^--XYZ\r\nContent-Disposition: form-data; name="filename"\r\n\r\na\.png\r\n/);
	assert.match(text, /name="file"; filename="a\.png"\r\nContent-Type: image\/png\r\n\r\n\x01\x02\x03\r\n--XYZ--\r\n$/);
});

test('firstWebUrl skips comments and non-web links', () => {
	assert.equal(firstWebUrl('# comment\r\nobsidian://open?x\r\nhttps://img.test/a.png\r\n'), 'https://img.test/a.png');
	assert.equal(firstWebUrl('not a url'), null);
});

test('resourcePathPart encodes each segment but keeps the drive letter', () => {
	assert.equal(resourcePathPart('C:\\Users\\안 창\\a#b.png'), 'C:/Users/%EC%95%88%20%EC%B0%BD/a%23b.png');
	assert.equal(resourcePathPart('/Users/me/pic.png'), 'Users/me/pic.png');
});
