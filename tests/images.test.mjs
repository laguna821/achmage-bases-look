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

test('parseImageInput understands every common way of pointing at an image', async () => {
	const { parseImageInput: p } = await import('../src/images.ts');
	const r2 = 'https://pub-acf6ad93f2ec4a5e8fa12e94d0c9b151.r2.dev/1785133935908-691d0f97.png';
	assert.deepEqual(p(`![image.png](${r2})`), { kind: 'url', url: r2 });
	assert.deepEqual(p(`[보기](<${r2}> "제목")`), { kind: 'url', url: r2 });
	assert.deepEqual(p(`  "${r2}",  `), { kind: 'url', url: r2 });
	assert.deepEqual(p(`<${r2}>`), { kind: 'url', url: r2 });
	assert.deepEqual(p(`see ${r2}.`), { kind: 'url', url: r2 });
	assert.deepEqual(p('<img alt="x" src="https://a.test/p.jpg?w=1&amp;h=2">'), { kind: 'url', url: 'https://a.test/p.jpg?w=1&h=2' });
	assert.deepEqual(p('www.example.com/pic.png'), { kind: 'url', url: 'https://www.example.com/pic.png' });
	assert.deepEqual(p('![[기생충.png|300]]'), { kind: 'vault', linkpath: '기생충.png' });
	assert.deepEqual(p('[[썸네일/기생충.png#x]]'), { kind: 'vault', linkpath: '썸네일/기생충.png' });
	assert.deepEqual(p('![](썸네일/%EA%B8%B0%EC%83%9D%EC%B6%A9.png)'), { kind: 'vault', linkpath: '썸네일/기생충.png' });
	assert.deepEqual(p('썸네일/기생충.png'), { kind: 'vault', linkpath: '썸네일/기생충.png' });
	assert.deepEqual(p('obsidian://open?vault=A&file=%EC%8D%B8%EB%84%A4%EC%9D%BC%2Fx.png'), { kind: 'vault', linkpath: '썸네일/x.png' });
	assert.deepEqual(p(String.raw`C:\Users\me\사진 1.png`), { kind: 'local', path: String.raw`C:\Users\me\사진 1.png` });
	assert.deepEqual(p(String.raw`"C:\Users\me\a.jpg"`), { kind: 'local', path: String.raw`C:\Users\me\a.jpg` });
	assert.deepEqual(p('file:///C:/Users/me/%EC%82%AC%EC%A7%84.png'), { kind: 'local', path: 'C:/Users/me/사진.png' });
	assert.deepEqual(p('file:///Users/me/a.png'), { kind: 'local', path: '/Users/me/a.png' });
	assert.deepEqual(p('/Users/me/a.png'), { kind: 'local', path: '/Users/me/a.png' });
	assert.deepEqual(p('data:image/png;base64,iVBORw0KGgo='), { kind: 'data', mime: 'image/png', base64: 'iVBORw0KGgo=' });
	assert.equal(p('   '), null);
	assert.equal(p('line one\nline two'), null);
});

test('isHostedOn recognises the own bucket and r2.dev addresses', async () => {
	const { isHostedOn } = await import('../src/images.ts');
	assert.equal(isHostedOn('https://img.example.com/a/b.png', 'https://img.example.com/'), true);
	assert.equal(isHostedOn('https://pub-abc123.r2.dev/x.png', ''), true);
	assert.equal(isHostedOn('https://other.test/x.png', 'https://img.example.com'), false);
});

test('youtubeId finds the video in every kind of YouTube address', async () => {
	const { youtubeId, youtubeThumbnails, youtubeWatchUrl } = await import('../src/images.ts');
	const id = 'dQw4w9WgXcQ';
	for (const url of [
		`https://www.youtube.com/watch?v=${id}`,
		`https://youtube.com/watch?app=desktop&v=${id}&list=PL1`,
		`https://m.youtube.com/watch?v=${id}`,
		`https://music.youtube.com/watch?v=${id}&si=abc`,
		`https://youtu.be/${id}?si=tracking`,
		`https://www.youtube.com/shorts/${id}`,
		`https://www.youtube.com/embed/${id}?start=30`,
		`https://www.youtube.com/live/${id}?feature=share`,
		`https://www.youtube-nocookie.com/embed/${id}`,
	]) assert.equal(youtubeId(url), id, url);
	for (const url of ['https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short', 'not a url']) {
		assert.equal(youtubeId(url), null, url);
	}
	assert.deepEqual(youtubeThumbnails(id), [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`]);
	assert.equal(youtubeWatchUrl(`https://youtu.be/${id}?si=x&t=95`, id), `https://www.youtube.com/watch?v=${id}&t=95`);
	assert.equal(youtubeWatchUrl(`https://www.youtube.com/shorts/${id}`, id), `https://www.youtube.com/watch?v=${id}`);
});
