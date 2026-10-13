# Contributing

Thanks for helping. Bug reports, ideas and pull requests are welcome.

## Reporting a bug

Open an issue at <https://github.com/laguna821/achmage-bases-look/issues> with:

- your Obsidian version and platform,
- the view type (cards, kanban, table or list) and what you did,
- what you expected and what happened, ideally with a screenshot.

For security problems, see [SECURITY.md](SECURITY.md).

## Working on the code

```bash
npm ci
npm run build       # main.js
npm run typecheck
npm run lint        # eslint-plugin-obsidianmd, aim for zero findings
npm test            # node --test
```

Copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/achmage-bases-look/` to try a change. Please use a test vault, not your real one.

- Each published version has its own branch (`1.0.2`, …). Open pull requests against the newest version branch.
- Keep the plugin's promises: no network use except on the user's request, no telemetry, and no change to notes the user did not ask for.
- Bases has no public API for its built-in views. Read Obsidian's objects defensively, as `src/native.ts` does, so a future Obsidian version only switches decorations off.
- User-facing text lives in `src/i18n.ts` in English and Korean. Add both.

## Releases

A release is created by pushing an annotated tag equal to the version in `manifest.json`. The release workflow checks versions, types, lint and tests, builds `main.js` (it must match the committed file), attaches `main.js`, `manifest.json` and `styles.css` with artifact attestations, and uses `release-notes/<version>.md` as the description.

---

**한국어**: 버그 제보와 제안, 풀 리퀘스트를 환영합니다. 이슈에는 Obsidian 버전, 뷰 종류, 재현 순서와 스크린샷을 적어 주세요. 버전마다 브랜치가 있으니 풀 리퀘스트는 가장 최신 버전 브랜치로 보내 주세요. 사용자가 요청하지 않은 네트워크 사용·통계 전송·노트 변경은 하지 않는다는 원칙을 지켜 주세요.
