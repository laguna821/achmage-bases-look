# Security

## What Achmage Bases Look touches

The plugin runs no programs and has no telemetry. Everything it does is listed here.

| When | What | Notes |
|---|---|---|
| Opening a base | Reads the base and the notes it shows. Nothing is written. | A base's own image property is found and used as it is. |
| You add a thumbnail | Writes the base's thumbnail property (`thumbnail` by default) in that note's frontmatter. Saves the image in the base's image folder. | Vault images you point at are linked, not copied. |
| You click **Thumbnails**, or change **This view** | Edits only that view in the `.base` file: standard Bases view settings (image, size, ratio, fit, thumbnail column) and an `achmageLook:` key inside the view for its look. | Other views are not touched. Obsidian keeps unknown view keys when it saves or renames the view. |
| You change **This base**, group colors, or turn thumbnails on or off in every view | Edits the `.base` file: the base's `achmageLook:` key, and for every view, standard settings where a view has none. | Existing image settings, ratios, fits, sizes and column widths you set are never replaced. |
| You rename a group and confirm | Writes the new value into the grouping property of every note in that group. | Only text values are changed. There is no undo, so the field says how many notes change before you confirm. |
| You add a group | Writes the view's `groupOrder`, the setting Obsidian uses for groups in manual order. | |
| A new base, or a view that just became a kanban, has no group property | Writes `groupBy` for that view (a status property the notes use, or the one from the settings), so its cards show. | Happens without a click, only for new bases and views. Existing bases are not changed. Turn it off in the settings or per base. |
| You enter or drop an image address | Downloads that one image with Obsidian's `requestUrl`. | Only `http` and `https`. |
| You enter or drop a YouTube link | Downloads (or, for link only, links) the video's preview image from `i.ytimg.com`, and writes the video address into the link property (`link` by default). | A different address already in the link property is never overwritten. Leave the property name empty to turn this off. |
| You click ▶ or the open button on a thumbnail | Opens the address from the note's link property in your browser. | Nothing is opened without a click. |
| You upload to Cloudflare R2 | Sends the image to **your own** worker (`Worker URL/upload`) with your API key. | The key is kept in Obsidian's secret storage, not in the plugin's settings file. |
| You open the Eagle panel or pick an Eagle image | Talks to the Eagle app on `localhost` (default `http://localhost:41595`) and reads the picked image file from your Eagle library. | Desktop only. The file is copied into the vault. |
| You paste a file path from your computer | Reads that one file and copies it into the vault. | Desktop only. |
| Obsidian starts | Checks whether this vault has CMDS Eagle settings (`.obsidian/plugins/cmds-eagle/data.json`) with a Cloudflare R2 worker, to offer **Import from CMDS Eagle**. | Nothing is copied until you click the button. |

## Undocumented interface

Bases has no public API for decorating its built-in views. The toolbar buttons, dashed frames, group colors and the Group menu section are added to Obsidian's own Bases interface. If a future Obsidian version changes that interface, these parts switch off quietly, while the commands, the thumbnail window and the base settings keep working.

## Reporting a problem

Please open an issue at <https://github.com/laguna821/achmage-bases-look/issues> titled "Security". Describe the impact, but leave out exploit details. The maintainer will follow up there.

---

**요약 (한국어)**: 이 플러그인은 프로그램을 실행하지 않고 사용 통계를 보내지 않습니다. 네트워크는 사용자가 요청할 때만 씁니다(입력한 주소의 이미지 내려받기, 본인 Cloudflare 워커로 업로드, `localhost`의 Eagle 앱). 볼트 밖 파일은 데스크톱에서 사용자가 고르거나 붙여넣은 이미지 한 장만 읽어 볼트로 복사합니다. 그룹 이름 바꾸기는 확인을 누른 뒤에만 그 그룹 노트들의 속성 값을 바꾸며 되돌리기가 없습니다. 베이스를 열기만 해서는 아무것도 쓰지 않으며, 썸네일을 켤 때도 이미지가 없는 뷰만 채우고 기존 설정은 바꾸지 않습니다. 그룹 기준 자동 지정은 새로 만든 베이스나 방금 칸반으로 바꾼 뷰에만 합니다. 유튜브 링크를 넣으면 `i.ytimg.com`에서 미리보기 이미지를 받고 영상 주소를 링크 속성에 저장하며(다른 주소는 덮어쓰지 않음), ▶ 버튼을 눌렀을 때만 브라우저로 엽니다. R2 API Key는 Obsidian 보안 저장소에 보관합니다.
