# 快记图标

采用用户选定的 C「蓝紫叠纸」方案：蓝紫圆角底、两张叠放便签、米白前纸、蓝色勾选。

- `logo-c.png`：内置 imagegen 以选定 C 原图为输入整理的透明底源图。
- `../public/logo.png`：从源图等比例导出的 256 × 256 PNG，供 uTools 与界面共同使用。
- 只处理外侧背景与输出尺寸，保留原有图形、配色和构图；不将图标源图打进运行包。

使用内置 imagegen，未调用 CLI/API 回退。两次编辑提示词如下。

## 去除外侧白底

Edit the supplied chosen app icon C ONLY to prepare the exact same identity for use as a software launcher icon. Preserve its periwinkle-blue rounded-square tile, the two offset sticky-note sheets, ivory front sheet with folded top-right corner, lavender back sheet, and bold cobalt-blue checkmark. Keep the same silhouettes, relative placement, colors and proportions. Remove ONLY the white background outside the rounded-square blue tile and make that outside area truly transparent. Keep the ivory paper fully opaque. Do not redesign or add anything. No letters, text, border, mockup, extra shadow or extra objects. Square PNG with the tile centered, nearly filling the canvas with a small transparent safety margin. Export-ready 256 x 256 pixel icon if supported. This is background extraction from an existing selected design, not a new concept.

## 复查透明边缘

Fix only the alpha boundary of this same selected C app icon. Preserve the interior of the blue rounded square and all paper sheets/checkmark exactly. The current transparent PNG has ugly isolated white flecks, blue specks, and a thin white fringe OUTSIDE the blue rounded-square silhouette. Delete ALL such outside flecks, dots, halo, fringe and artifacts. Outside the single rounded square must be absolutely empty with alpha=0, including all four corners and every pixel of the safety margin. Keep a smooth antialiased clean silhouette around the tile, with no outline. Do not add any new background, border, shadow, texture, padding element or extra detail. Do not change the icon design, colors, paper fold or checkmark. Return a clean transparent square PNG suitable as a polished small software launcher icon.
