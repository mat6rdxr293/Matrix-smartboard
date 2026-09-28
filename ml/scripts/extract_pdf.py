"""Извлечение текста из PDF-учебников по страницам.

Вход:  textbooks/<предмет>/<класс>/*.pdf   (например textbooks/physics/10/fizika_10_kk.pdf)
Выход: data/raw/<предмет>_<класс>_<имя файла>.jsonl — по строке на страницу:
    {doc_id, source, subject, grade, page, text, n_chars, lang_guess,
     method: "text" | "ocr" | "none", needs_ocr, ocr_reason}

Страница помечается needs_ocr=true, если в ней почти нет текстового слоя (скан)
или текст — «мусор» из-за битой кодировки шрифтов (частая беда казахских PDF).
С флагом --ocr такие страницы распознаются Tesseract (kaz+rus+eng) — нужен
установленный tesseract с языковыми пакетами:
    sudo apt install tesseract-ocr tesseract-ocr-kaz tesseract-ocr-rus tesseract-ocr-eng

Примеры:
    python scripts/extract_pdf.py                 # только текстовый слой, сканы помечаются
    python scripts/extract_pdf.py --ocr           # + OCR помеченных страниц
    python scripts/extract_pdf.py --force         # перезаписать уже обработанные файлы
"""
import argparse
import json
import re
import shutil
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
MIN_CHARS = 40          # меньше значащих символов на странице → считаем сканом
MAX_BAD_RATIO = 0.1     # доля «мусорных» символов выше → битая кодировка
OCR_LANGS = "kaz+rus+eng"
OCR_DPI = 300

# буквы, которые есть в казахском, но нет в русском/узбекском (қ, ғ есть и в узбекском — их не берём)
KK_LETTERS = set("әңөұүһіӘҢӨҰҮҺІ")
UZ_LETTERS = set("ўҳЎҲ")  # узбекская кириллица: в Казахстане есть учебники для узбекских школ
KK_MIN_SHARE = 0.04       # доля этих букв среди кириллицы, начиная с которой текст считаем казахским
# В учебниках на kk/ru/en не бывает Latin-1/Latin Extended букв (Í, þ, µ...), U+FFFD и
# private use — это признак шрифта без ToUnicode (кириллица, сохранённая как «кракозябры»).
BAD_CHAR = re.compile(r"[\u0080-\u024f\ufffd\ue000-\uf8ff]")
CYR = re.compile(r"[а-яёА-ЯЁ]")
# латиница для определения языка: только слова от 4 букв — переменные (F, ma), функции (cos)
# и единицы (kg, Hz) в формулах без разметки словами не считаются
LAT_WORD = re.compile(r"(?<![a-zA-Z])[a-zA-Z]{4,}")
FORMULA = re.compile(r"\$\$.+?\$\$|\$[^$\n]+?\$|\\\(.+?\\\)|\\\[.+?\\\]", re.S)
TEX_CMD = re.compile(r"\\[a-zA-Z]+")  # LaTeX-команды вне формул: \alpha, \frac…
MIN_CYR_VS_LAT = 0.3  # для kk/uz кириллицы должно быть не меньше 30% от латиницы


def normalize(text):
    text = text.replace("­", "")                  # мягкие переносы
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)       # перенос слова по дефису
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def strip_formulas(text):
    """Убрать формулы: их латиница (B, S, \\cos\\alpha…) ничего не говорит о языке текста."""
    text = FORMULA.sub(" ", text)
    return TEX_CMD.sub(" ", text)


def lang_guess(text):
    # Tesseract с kaz+rus вставляет казахские буквы и в русский текст (і вместо i, Ә вместо д…),
    # поэтому смотрим на долю: в русских учебниках её ≤ 2% по параграфу, в казахских ≥ 7%.
    # Долю проверяем до сравнения с латиницей: в казахской физике много переменных и единиц,
    # даже вне $…$ (у Tesseract формулы — простой текст).
    if not text:
        return None
    text = strip_formulas(text)
    kk = sum(c in KK_LETTERS for c in text)
    uz = sum(c in UZ_LETTERS for c in text)
    cyr = len(CYR.findall(text)) + kk + uz
    lat = sum(len(w) for w in LAT_WORD.findall(text))
    if cyr == lat == 0:
        return None
    # кириллицы должно быть хотя бы заметно: иначе английский текст с казахским именем стал бы kk
    if max(kk, uz) >= KK_MIN_SHARE * cyr and cyr >= MIN_CYR_VS_LAT * lat:
        return "kk" if kk >= uz else "uz"
    return "ru" if cyr >= lat else "en"


def ocr_reason(text):
    """None, если текстовый слой пригоден; иначе причина, по которой нужен OCR."""
    chars = [c for c in text if not c.isspace()]
    if len(chars) < MIN_CHARS:
        return "no_text_layer"
    bad = sum(1 for c in chars if BAD_CHAR.match(c) and c not in "«»°±×÷·§²³¹µ")
    if bad / len(chars) > MAX_BAD_RATIO:
        return "bad_encoding"
    return None


def tesseract_ready():
    """Проверяет наличие tesseract и нужных языков. Возвращает (ok, сообщение)."""
    if shutil.which("tesseract") is None:
        return False, "tesseract не установлен"
    try:
        import pytesseract
        have = set(pytesseract.get_languages(config=""))
    except Exception as e:  # noqa: BLE001
        return False, f"pytesseract не работает: {e}"
    missing = set(OCR_LANGS.split("+")) - have
    if missing:
        return False, f"нет языковых пакетов tesseract: {', '.join(sorted(missing))}"
    return True, "ok"


def ocr_page(page):
    import pytesseract
    from PIL import Image

    pix = page.get_pixmap(dpi=OCR_DPI)
    img = Image.frombytes("RGB" if pix.n < 4 else "RGBA", (pix.width, pix.height), pix.samples)
    return pytesseract.image_to_string(img, lang=OCR_LANGS)


def find_boilerplate(texts, min_share=0.5):
    """Строки, повторяющиеся на большинстве страниц: водяные знаки сайтов, колонтитулы.

    Пример: сканы с okulyk.kz, где единственный «текст» страницы — две строки водяного знака.
    Без этой чистки такие страницы выглядят текстовыми и не попадают в OCR.
    """
    if len(texts) < 4:
        return set()
    counts = Counter(line.strip() for t in texts for line in set(t.splitlines()) if line.strip())
    return {line for line, n in counts.items() if n >= min_share * len(texts)}


def strip_lines(text, boilerplate):
    return "\n".join(l for l in text.splitlines() if l.strip() not in boilerplate).strip()


def process_pdf(pdf_path, src_root, subject, grade, out_path, do_ocr):
    t0 = time.perf_counter()
    doc = pymupdf.open(pdf_path)
    doc_id = f"{subject}_{grade}_{pdf_path.stem}"
    stats = {"pages": len(doc), "text": 0, "ocr": 0, "needs_ocr": 0}
    raw = [normalize(page.get_text("text", sort=True)) for page in doc]
    boilerplate = find_boilerplate(raw)
    if boilerplate:
        stats["boilerplate"] = sorted(boilerplate)
    tmp_path = out_path.with_suffix(".jsonl.part")  # недописанный файл не выглядит готовым
    with open(tmp_path, "w", encoding="utf-8") as f:
        for page in doc:
            text = strip_lines(raw[page.number], boilerplate)
            reason = ocr_reason(text)
            method = "text" if reason is None else "none"
            if reason and do_ocr:
                # водяной знак нарисован и на картинке, поэтому OCR его тоже прочитает — чистим так же
                ocr_text = strip_lines(normalize(ocr_page(page)), boilerplate)
                if ocr_reason(ocr_text) is None:
                    text, method = ocr_text, "ocr"
            needs_ocr = reason is not None and method != "ocr"
            if method in ("text", "ocr"):
                stats[method] += 1
            stats["needs_ocr"] += needs_ocr
            rec = {
                "doc_id": doc_id,
                "source": str(pdf_path.relative_to(src_root)),
                "subject": subject,
                "grade": grade,
                "page": page.number + 1,
                "text": text if method != "none" else "",
                "n_chars": len(text) if method != "none" else 0,
                "lang_guess": lang_guess(text) if method != "none" else None,
                "method": method,
                "needs_ocr": needs_ocr,
                "ocr_reason": reason,
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    tmp_path.replace(out_path)
    stats["time_s"] = time.perf_counter() - t0
    return stats


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--textbooks", default=str(ROOT / "textbooks"))
    ap.add_argument("--out", default=str(ROOT / "data" / "raw"))
    ap.add_argument("--ocr", action="store_true", help="распознать помеченные страницы Tesseract")
    ap.add_argument("--force", action="store_true", help="перезаписывать уже готовые jsonl")
    ap.add_argument("--jobs", type=int, default=1, help="сколько PDF обрабатывать параллельно")
    args = ap.parse_args()

    src, out_dir = Path(args.textbooks), Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.ocr:
        ok, msg = tesseract_ready()
        if not ok:
            sys.exit(f"--ocr недоступен: {msg}")

    pdfs = sorted(src.glob("*/*/*.pdf")) + sorted(src.glob("*/*/*.PDF"))
    if not pdfs:
        print(f"PDF не найдено. Ожидается структура {src}/<предмет>/<класс>/*.pdf")
        return

    jobs = []
    for pdf in pdfs:
        subject, grade = pdf.parent.parent.name, pdf.parent.name
        grade = int(grade) if grade.isdigit() else grade
        out_path = out_dir / f"{subject}_{grade}_{pdf.stem}.jsonl"
        if out_path.exists() and not args.force:
            print(f"пропуск (уже есть): {out_path.name}")
            continue
        jobs.append((pdf, src, subject, grade, out_path, args.ocr))

    total = {"pages": 0, "text": 0, "ocr": 0, "needs_ocr": 0}
    # несколько PDF параллельно (для подготовки данных); на доске — один учебник, --jobs 1
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futures = {ex.submit(process_pdf, *job): job for job in jobs}
        for fut in as_completed(futures):
            pdf, out_path = futures[fut][0], futures[fut][4]
            try:
                st = fut.result()
            except Exception as e:  # noqa: BLE001 — один битый PDF не должен ронять весь прогон
                print(f"ОШИБКА {pdf}: {e}", flush=True)
                continue
            for k in total:
                total[k] += st[k]
            print(f"{pdf.relative_to(src)}: {st['pages']} стр., текст {st['text']}, OCR {st['ocr']}, "
                  f"требуют OCR {st['needs_ocr']}, {st['time_s']:.0f} с → {out_path.name}", flush=True)
            if st.get("boilerplate"):
                print(f"  вырезаны повторяющиеся строки: {st['boilerplate']}", flush=True)

    print(f"\nИтого: {total['pages']} стр., текст {total['text']}, OCR {total['ocr']}, "
          f"требуют OCR {total['needs_ocr']}")
    if total["needs_ocr"] and not args.ocr:
        print("Есть страницы без текстового слоя — запустите с --ocr (нужен tesseract kaz+rus+eng).")


if __name__ == "__main__":
    main()
