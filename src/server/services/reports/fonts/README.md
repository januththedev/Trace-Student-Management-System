# Report fonts

Noto Sans Sinhala and Noto Sans Tamil are bundled under the adjacent SIL Open Font
License files. Both include Latin glyphs. Reports embed these local files and make
no font network requests.

Sources: Google Fonts repository, `ofl/notosanssinhala/NotoSansSinhala[wdth,wght].ttf`
and `ofl/notosanstamil/NotoSansTamil[wdth,wght].ttf`, retrieved 2026-11-17.
https://github.com/google/fonts/tree/main/ofl/notosanssinhala
https://github.com/google/fonts/tree/main/ofl/notosanstamil

The variable originals were instantiated with FontTools at `wght=400, wdth=100`
to create static regular TTFs. Full embedding preserves shaped Sinhala/Tamil
outlines; font subsetting produced missing glyphs in rendered PDF pages.
