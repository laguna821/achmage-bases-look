# Security

## What Achmage Bases Look touches

The plugin runs no programs and has no telemetry. Everything it does is listed here.

| When | What | Notes |
|---|---|---|
| You add a thumbnail | Writes one property (`thumbnail` by default) in that note's frontmatter. Saves the image in the image folder from the settings. | Vault images you point at are linked, not copied. |
| You turn thumbnails on, change the look, or set group colors | Edits the `.base` file: standard Bases view settings, an `image()` formula, and an `achmageLook:` key. | Obsidian keeps the `achmageLook:` key when it saves the base. |
| You rename a group and confirm | Writes the new value into the grouping property of every note in that group. | Only text values are changed. There is no undo, so the field says how many notes change before you confirm. |
| You add a group | Writes the view's `groupOrder`, the setting Obsidian uses for groups in manual order. | |
| A kanban view has no group property | Writes `groupBy` for that view in the `.base` file (a status property the notes use, or the one from the settings), so its cards show. | Happens without a click. Turn off **Ready-to-use new kanban views** to leave such views alone. A grouping you removed yourself is not added back. |
| You enter or drop an image address | Downloads that one image with Obsidian's `requestUrl`. | Only `http` and `https`. |
| You upload to Cloudflare R2 | Sends the image to **your own** worker (`Worker URL/upload`) with your API key. | The key is kept in Obsidian's secret storage, not in the plugin's settings file. |
| You open the Eagle panel or pick an Eagle image | Talks to the Eagle app on `localhost` (default `http://localhost:41595`) and reads the picked image file from your Eagle library. | Desktop only. The file is copied into the vault. |
| You paste a file path from your computer | Reads that one file and copies it into the vault. | Desktop only. |
| Obsidian starts | Checks whether this vault has CMDS Eagle settings (`.obsidian/plugins/cmds-eagle/data.json`) with a Cloudflare R2 worker, to offer **Import from CMDS Eagle**. | Nothing is copied until you click the button. |

## Undocumented interface

Bases has no public API for decorating its built-in views. The toolbar buttons, dashed frames, group colors and the Group menu section are added to Obsidian's own Bases interface. If a future Obsidian version changes that interface, these parts switch off quietly, while the commands, the thumbnail window and the base settings keep working.

## Reporting a problem

Please open an issue at <https://github.com/laguna821/achmage-bases-look/issues> titled "Security". Describe the impact, but leave out exploit details. The maintainer will follow up there.

---

**요약 (한국어)**: 이 플러그인은 프로그램을 실행하지 않고 사용 통계를 보내지 않습니다. 네트워크는 사용자가 요청할 때만 씁니다(입력한 주소의 이미지 내려받기, 본인 Cloudflare 워커로 업로드, `localhost`의 Eagle 앱). 볼트 밖 파일은 데스크톱에서 사용자가 고르거나 붙여넣은 이미지 한 장만 읽어 볼트로 복사합니다. 그룹 이름 바꾸기는 확인을 누른 뒤에만 그 그룹 노트들의 속성 값을 바꾸며 되돌리기가 없습니다. 그룹 기준이 없는 칸반은 누르지 않아도 `.base`에 그룹 기준을 써서 카드가 보이게 합니다(설정 **새 칸반 바로 쓰기**로 끔, 직접 지운 기준은 다시 쓰지 않음). R2 API Key는 Obsidian 보안 저장소에 보관합니다.
