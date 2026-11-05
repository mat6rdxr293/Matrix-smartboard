from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import logging
import re
import shutil
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from openai import OpenAI

from .settings import ROOT_DIR, get_openai_key, settings

logger = logging.getLogger("textbook-library")

ML_ROOT = ROOT_DIR / "ml"
DATA_ROOT = ML_ROOT / "data"
TEXTBOOK_DIR = DATA_ROOT / "textbooks"
RAW_DIR = DATA_ROOT / "raw"
SECTIONS_DIR = DATA_ROOT / "sections"
LIBRARY_DIR = DATA_ROOT / "library"
PAGE_IMAGE_DIR = DATA_ROOT / "page-images"
INDEX_PATH = DATA_ROOT / "page-index.sqlite3"

MAX_PDF_BYTES = 250 * 1024 * 1024
AI_OCR_DPI = 150

_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="textbook-ingest")
_jobs_lock = threading.Lock()
_index_lock = threading.Lock()
_active_jobs: set[str] = set()
_legacy_index_checked = False


def _ensure_dirs() -> None:
    for path in (TEXTBOOK_DIR, RAW_DIR, SECTIONS_DIR, LIBRARY_DIR):
        path.mkdir(parents=True, exist_ok=True)


def _atomic_json(path: Path, payload: dict[str, Any] | list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def _meta_path(book_id: str) -> Path:
    return LIBRARY_DIR / f"{Path(book_id).name}.json"


def _read_meta(book_id: str) -> dict[str, Any] | None:
    path = _meta_path(book_id)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _write_meta(book_id: str, **changes: Any) -> dict[str, Any]:
    current = _read_meta(book_id) or {"id": book_id}
    current.update(changes)
    current["updatedAt"] = int(time.time() * 1000)
    _atomic_json(_meta_path(book_id), current)
    return current


def _slug(filename: str) -> str:
    stem = Path(filename).stem
    value = re.sub(r"[^0-9A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі_-]+", "-", stem)
    value = re.sub(r"-+", "-", value).strip("-_")
    return value[:48] or "textbook"


def _book_id(filename: str, digest: str) -> str:
    return f"{_slug(filename)}-{digest[:10]}"


def _module_from_path(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Не удалось загрузить {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _extract_helpers():
    return _module_from_path("matrix_ml_extract_pdf", ML_ROOT / "scripts" / "extract_pdf.py")


def _section_helpers():
    return _module_from_path("matrix_ml_sections", ML_ROOT / "scripts" / "sections.py")


def _connect_index() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(INDEX_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
            book_id UNINDEXED,
            page UNINDEXED,
            section_num UNINDEXED,
            section_title,
            text,
            tokenize='unicode61 remove_diacritics 2'
        )
        """
    )
    return conn


def _clear_index(book_id: str) -> None:
    with _index_lock, _connect_index() as conn:
        conn.execute("DELETE FROM page_fts WHERE book_id = ?", (book_id,))
        conn.commit()


def _index_page(
    book_id: str,
    page: int,
    text: str,
    *,
    section_num: str = "",
    section_title: str = "",
) -> None:
    if not text.strip():
        return
    with _index_lock, _connect_index() as conn:
        conn.execute(
            "INSERT INTO page_fts(book_id, page, section_num, section_title, text) VALUES (?, ?, ?, ?, ?)",
            (book_id, int(page), section_num, section_title, text),
        )
        conn.commit()


def _apply_sections_to_index(book_id: str, sections: list[dict[str, Any]], pages: list[dict[str, Any]]) -> None:
    by_page: dict[int, tuple[str, str]] = {}
    for section in sections:
        start = int(section.get("page_start", 0) or 0)
        end = int(section.get("page_end", start) or start)
        for page in range(start, end + 1):
            by_page[page] = (
                str(section.get("num", "")),
                str(section.get("title", "")),
            )

    with _index_lock, _connect_index() as conn:
        conn.execute("DELETE FROM page_fts WHERE book_id = ?", (book_id,))
        conn.executemany(
            "INSERT INTO page_fts(book_id, page, section_num, section_title, text) VALUES (?, ?, ?, ?, ?)",
            [
                (
                    book_id,
                    int(item["page"]),
                    by_page.get(int(item["page"]), ("", ""))[0],
                    by_page.get(int(item["page"]), ("", ""))[1],
                    str(item.get("text", "")),
                )
                for item in pages
                if str(item.get("text", "")).strip()
            ],
        )
        conn.commit()


def _search_expression(query: str) -> str:
    terms = re.findall(r"[0-9A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]{2,}", query)
    if not terms:
        return ""
    # Prefix matching handles common RU/KK endings: логарифм -> логарифмы/логарифмический.
    return " OR ".join(f'"{term.replace(chr(34), "")}"*' for term in terms[:12])


def search_pages(book_id: str, query: str, limit: int = 6) -> list[dict[str, Any]]:
    safe_book = Path(book_id).name
    expression = _search_expression(query)
    if not expression:
        return []
    safe_limit = max(1, min(int(limit), 20))

    with _index_lock, _connect_index() as conn:
        rows = conn.execute(
            """
            SELECT
                page,
                section_num,
                section_title,
                snippet(page_fts, 4, '⟦', '⟧', ' … ', 22) AS excerpt,
                bm25(page_fts) AS rank
            FROM page_fts
            WHERE page_fts MATCH ? AND book_id = ?
            ORDER BY rank
            LIMIT ?
            """,
            (expression, safe_book, safe_limit),
        ).fetchall()

    return [
        {
            "page": int(row[0]),
            "section": str(row[1] or ""),
            "sectionTitle": str(row[2] or ""),
            "excerpt": str(row[3] or "").replace("\n", " ").strip(),
            "rank": float(row[4]),
        }
        for row in rows
    ]


def search_context(book_id: str, query: str, *, limit: int = 5, max_chars: int = 9000) -> tuple[str, list[int]]:
    hits = search_pages(book_id, query, limit=limit)
    if not hits:
        raise ValueError("По этой теме в учебнике ничего не найдено")

    pages_by_number = load_pages(book_id)
    selected: list[int] = []
    for hit in hits:
        page = int(hit["page"])
        if page not in selected:
            selected.append(page)

    chunks: list[str] = []
    used = 0
    for page in selected:
        item = pages_by_number.get(page)
        if not item:
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        chunk = f"[стр. {page}]\n{text}"
        remaining = max_chars - used
        if remaining <= 0:
            break
        chunks.append(chunk[:remaining])
        used += min(len(chunk), remaining)

    context = "\n\n".join(chunks).strip()
    if len(context) < 80:
        raise ValueError("На найденных страницах недостаточно распознанного текста")
    return context, selected


def load_pages(book_id: str) -> dict[int, dict[str, Any]]:
    safe_book = Path(book_id).name
    path = RAW_DIR / f"{safe_book}.jsonl"
    if not path.exists():
        partial = RAW_DIR / f"{safe_book}.jsonl.part"
        if partial.exists():
            path = partial
    result: dict[int, dict[str, Any]] = {}
    if not path.exists():
        return result
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        try:
            item = json.loads(line)
            result[int(item["page"])] = item
        except Exception:
            continue
    return result


def _tesseract_state(extract) -> tuple[bool, str]:
    try:
        return extract.tesseract_ready()
    except Exception as exc:
        return False, str(exc)


PAGE_IMAGE_WIDTHS = (800, 1400, 2000)


def render_page_image(book_id: str, page_number: int, width: int = 1400) -> Path:
    """JPEG of one textbook page for placing on the board, cached per width.

    `page_number` is 1-based, as shown to teachers. Raises ValueError for an unknown book or page.
    """
    safe_id = Path(book_id).name
    pdf_path = TEXTBOOK_DIR / f"{safe_id}.pdf"
    if not pdf_path.exists():
        raise ValueError("Учебник не найден")
    # Only a few sizes, so the cache cannot be filled with arbitrary widths.
    width = min(PAGE_IMAGE_WIDTHS, key=lambda candidate: abs(candidate - width))
    PAGE_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    target = PAGE_IMAGE_DIR / f"{safe_id}-p{page_number}-w{width}.jpg"
    if target.exists() and target.stat().st_mtime >= pdf_path.stat().st_mtime:
        return target
    import PIL.Image
    import pymupdf

    doc = pymupdf.open(pdf_path)
    try:
        if not 1 <= page_number <= doc.page_count:
            raise ValueError("Такой страницы нет")
        page = doc[page_number - 1]
        zoom = width / max(1.0, page.rect.width)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
        image = PIL.Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        tmp = target.with_suffix(".jpg.part")
        image.save(tmp, format="JPEG", quality=86, optimize=True)
        tmp.replace(target)
    finally:
        doc.close()
    return target


def _vision_ocr_available() -> bool:
    return bool(settings.ocr_base_url or get_openai_key())


def _page_png(page) -> bytes:
    pix = page.get_pixmap(dpi=AI_OCR_DPI, alpha=False)
    import PIL.Image

    image = PIL.Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=88, optimize=True)
    return output.getvalue()


def _vision_ocr_page(page) -> str:
    api_key = get_openai_key()
    base_url = settings.ocr_base_url
    if not api_key and not base_url:
        raise RuntimeError("OCR backend is not configured")

    options: dict[str, Any] = {
        "api_key": api_key or "ollama",
        "timeout": max(settings.ai_timeout_seconds, 180.0),
    }
    if base_url:
        options["base_url"] = base_url
    client = OpenAI(**options)

    image_bytes = _page_png(page)
    data_url = "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode("ascii")
    prompt = (
        "Точное OCR одной страницы школьного учебника. Перепиши весь читаемый текст страницы сверху вниз. "
        "Сохраняй заголовки, номера параграфов, списки, подписи и формулы. Не решай задачи и не добавляй объяснений. "
        "Формулы можно писать обычным текстом/Unicode или LaTeX. Верни только содержимое страницы."
    )

    if base_url:
        response = client.chat.completions.create(
            model=settings.ocr_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            temperature=0,
            max_tokens=4096,
        )
        return (response.choices[0].message.content or "").strip()

    response = client.responses.create(
        model=settings.ocr_model,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        max_output_tokens=4096,
    )
    return (response.output_text or "").strip()


def _status_label(meta: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": meta.get("id"),
        "label": meta.get("label") or meta.get("filename") or meta.get("id"),
        "filename": meta.get("filename"),
        "status": meta.get("status", "unknown"),
        "stage": meta.get("stage", ""),
        "progress": float(meta.get("progress", 0.0) or 0.0),
        "totalPages": int(meta.get("totalPages", 0) or 0),
        "processedPages": int(meta.get("processedPages", 0) or 0),
        "indexedPages": int(meta.get("indexedPages", 0) or 0),
        "ocrPages": int(meta.get("ocrPages", 0) or 0),
        "needsOcrPages": int(meta.get("needsOcrPages", 0) or 0),
        "searchReady": bool(meta.get("searchReady")),
        "error": meta.get("error"),
        "sha256": meta.get("sha256"),
        "createdAt": meta.get("createdAt"),
        "updatedAt": meta.get("updatedAt"),
    }


def _load_sections(book_id: str) -> list[dict[str, Any]]:
    path = SECTIONS_DIR / f"{Path(book_id).name}.json"
    if not path.exists():
        return []
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except Exception:
        return []


def _index_count(book_id: str) -> int:
    with _index_lock, _connect_index() as conn:
        return int(
            conn.execute("SELECT count(*) FROM page_fts WHERE book_id = ?", (book_id,)).fetchone()[0]
        )


def list_textbooks() -> dict[str, Any]:
    global _legacy_index_checked
    _ensure_dirs()
    if not _legacy_index_checked:
        try:
            rebuild_missing_indexes()
        except Exception as exc:
            logger.warning("Could not build legacy textbook indexes: %s", exc)
        _legacy_index_checked = True

    books: list[dict[str, Any]] = []
    known_ids: set[str] = set()

    for meta_path in sorted(LIBRARY_DIR.glob("*.json")):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(meta, dict) or not meta.get("id"):
            continue
        book_id = str(meta["id"])
        known_ids.add(book_id)
        item = _status_label(meta)
        item["sections"] = [
            {
                "id": str(section.get("num", "")),
                "title": str(section.get("title", "")),
                "pageStart": int(section.get("page_start", 0) or 0),
                "pageEnd": int(section.get("page_end", 0) or 0),
            }
            for section in _load_sections(book_id)
            if str(section.get("num", "")).strip()
        ]
        books.append(item)

    # Backwards compatibility with manually prepared Kerei datasets.
    for raw_path in sorted(RAW_DIR.glob("*.jsonl")):
        book_id = raw_path.stem
        if book_id in known_ids:
            continue
        sections = _load_sections(book_id)
        page_count = len(load_pages(book_id))
        indexed_count = _index_count(book_id)
        books.append(
            {
                "id": book_id,
                "label": re.sub(r"[_-]+", " ", book_id).strip().capitalize(),
                "filename": None,
                "status": "ready",
                "stage": "ready",
                "progress": 1.0,
                "totalPages": page_count,
                "processedPages": page_count,
                "indexedPages": indexed_count,
                "ocrPages": 0,
                "needsOcrPages": 0,
                "searchReady": indexed_count > 0,
                "error": None,
                "sections": [
                    {
                        "id": str(section.get("num", "")),
                        "title": str(section.get("title", "")),
                        "pageStart": int(section.get("page_start", 0) or 0),
                        "pageEnd": int(section.get("page_end", 0) or 0),
                    }
                    for section in sections
                    if str(section.get("num", "")).strip()
                ],
            }
        )

    books.sort(key=lambda item: (item.get("status") != "processing", str(item.get("label", "")).lower()))
    return {"books": books, "mlDataAvailable": bool(books)}


def _section_for_page(page: int, sections: list[dict[str, Any]]) -> tuple[str, str]:
    for section in sections:
        start = int(section.get("page_start", 0) or 0)
        end = int(section.get("page_end", start) or start)
        if start <= page <= end:
            return str(section.get("num", "")), str(section.get("title", ""))
    return "", ""


def _process_textbook(book_id: str) -> None:
    try:
        _ensure_dirs()
        meta = _read_meta(book_id)
        if not meta:
            raise RuntimeError("Метаданные учебника не найдены")

        pdf_path = TEXTBOOK_DIR / f"{book_id}.pdf"
        raw_path = RAW_DIR / f"{book_id}.jsonl"
        sections_path = SECTIONS_DIR / f"{book_id}.json"
        if not pdf_path.exists():
            raise RuntimeError("Исходный PDF не найден")

        import pymupdf

        extract = _extract_helpers()
        sections_helper = _section_helpers()
        tesseract_ok, tesseract_message = _tesseract_state(extract)
        vision_ok = _vision_ocr_available()

        _write_meta(
            book_id,
            status="processing",
            stage="opening",
            progress=0.01,
            error=None,
            ocrBackend="tesseract" if tesseract_ok else ("vision" if vision_ok else "none"),
            ocrWarning=None if tesseract_ok or vision_ok else tesseract_message,
        )

        doc = pymupdf.open(pdf_path)
        total = len(doc)
        if total <= 0:
            raise RuntimeError("PDF не содержит страниц")

        _write_meta(book_id, totalPages=total, stage="extracting", progress=0.02)
        raw_texts = [extract.normalize(page.get_text("text", sort=True)) for page in doc]
        boilerplate = extract.find_boilerplate(raw_texts)
        _clear_index(book_id)

        pages: list[dict[str, Any]] = []
        part_path = raw_path.with_suffix(".jsonl.part")
        processed = 0
        indexed = 0
        ocr_pages = 0
        missing_ocr = 0

        with part_path.open("w", encoding="utf-8") as output:
            for page in doc:
                page_number = page.number + 1
                text = extract.strip_lines(raw_texts[page.number], boilerplate)
                reason = extract.ocr_reason(text)
                method = "text" if reason is None else "none"

                if reason:
                    ocr_text = ""
                    if tesseract_ok:
                        try:
                            ocr_text = extract.strip_lines(extract.normalize(extract.ocr_page(page)), boilerplate)
                        except Exception as exc:
                            logger.warning("Tesseract OCR failed for %s page %s: %s", book_id, page_number, exc)
                    elif vision_ok:
                        try:
                            ocr_text = extract.strip_lines(extract.normalize(_vision_ocr_page(page)), boilerplate)
                        except Exception as exc:
                            logger.warning("Vision OCR failed for %s page %s: %s", book_id, page_number, exc)

                    if ocr_text and extract.ocr_reason(ocr_text) is None:
                        text = ocr_text
                        method = "ocr"
                        ocr_pages += 1
                    else:
                        missing_ocr += 1

                usable = method in {"text", "ocr"} and bool(text.strip())
                record = {
                    "doc_id": book_id,
                    "source": meta.get("filename"),
                    "subject": meta.get("subject"),
                    "grade": meta.get("grade"),
                    "page": page_number,
                    "text": text if usable else "",
                    "n_chars": len(text) if usable else 0,
                    "lang_guess": extract.lang_guess(text) if usable else None,
                    "method": method,
                    "needs_ocr": not usable,
                    "ocr_reason": reason,
                }
                pages.append(record)
                output.write(json.dumps(record, ensure_ascii=False) + "\n")
                output.flush()

                if usable:
                    _index_page(book_id, page_number, text)
                    indexed += 1

                processed += 1
                _write_meta(
                    book_id,
                    stage="ocr" if reason else "extracting",
                    processedPages=processed,
                    indexedPages=indexed,
                    ocrPages=ocr_pages,
                    needsOcrPages=missing_ocr,
                    searchReady=indexed > 0,
                    progress=min(0.88, 0.04 + 0.84 * processed / total),
                )

        part_path.replace(raw_path)
        _write_meta(book_id, stage="sections", progress=0.90)

        try:
            found = sections_helper.find_sections(pages)
        except Exception as exc:
            logger.warning("Section detection failed for %s: %s", book_id, exc)
            found = []
        _atomic_json(sections_path, found)

        _write_meta(book_id, stage="indexing", progress=0.95)
        _apply_sections_to_index(book_id, found, pages)

        usable_pages = sum(1 for item in pages if str(item.get("text", "")).strip())
        final_status = "ready" if usable_pages == total else "partial"
        _write_meta(
            book_id,
            status=final_status,
            stage="ready",
            progress=1.0,
            processedPages=total,
            indexedPages=usable_pages,
            ocrPages=ocr_pages,
            needsOcrPages=total - usable_pages,
            sectionsCount=len(found),
            searchReady=usable_pages > 0,
            error=None,
        )
    except Exception as exc:
        logger.exception("Textbook ingestion failed: %s", book_id)
        _write_meta(
            book_id,
            status="error",
            stage="error",
            error=str(exc),
        )
    finally:
        with _jobs_lock:
            _active_jobs.discard(book_id)


def enqueue_textbook(filename: str, data: bytes) -> dict[str, Any]:
    if not filename.lower().endswith(".pdf"):
        raise ValueError("Нужен файл PDF")
    if not data or not data.startswith(b"%PDF"):
        raise ValueError("Файл не похож на PDF")
    if len(data) > MAX_PDF_BYTES:
        raise ValueError("PDF слишком большой. Максимальный размер — 250 МБ")

    _ensure_dirs()
    digest = hashlib.sha256(data).hexdigest()

    for meta_path in LIBRARY_DIR.glob("*.json"):
        try:
            existing = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(existing, dict) and existing.get("sha256") == digest:
            book_id = str(existing["id"])
            if existing.get("status") in {"error", "partial"}:
                submit_processing(book_id)
            return _status_label(existing)

    book_id = _book_id(filename, digest)
    pdf_path = TEXTBOOK_DIR / f"{book_id}.pdf"
    tmp = pdf_path.with_suffix(".pdf.part")
    tmp.write_bytes(data)
    tmp.replace(pdf_path)

    now = int(time.time() * 1000)
    meta = {
        "id": book_id,
        "label": Path(filename).stem,
        "filename": Path(filename).name,
        "sha256": digest,
        "sizeBytes": len(data),
        "status": "queued",
        "stage": "queued",
        "progress": 0.0,
        "totalPages": 0,
        "processedPages": 0,
        "indexedPages": 0,
        "ocrPages": 0,
        "needsOcrPages": 0,
        "searchReady": False,
        "error": None,
        "createdAt": now,
        "updatedAt": now,
    }
    _atomic_json(_meta_path(book_id), meta)
    submit_processing(book_id)
    return _status_label(meta)


def submit_processing(book_id: str) -> bool:
    safe_book = Path(book_id).name
    with _jobs_lock:
        if safe_book in _active_jobs:
            return False
        _active_jobs.add(safe_book)
    try:
        _executor.submit(_process_textbook, safe_book)
    except Exception:
        with _jobs_lock:
            _active_jobs.discard(safe_book)
        raise
    return True


def reindex_textbook(book_id: str) -> dict[str, Any]:
    safe_book = Path(book_id).name
    meta = _read_meta(safe_book)
    if not meta:
        raise ValueError("Учебник не найден")
    _write_meta(safe_book, status="queued", stage="queued", progress=0.0, error=None)
    submit_processing(safe_book)
    return _status_label(_read_meta(safe_book) or meta)


def delete_textbook(book_id: str) -> None:
    safe_book = Path(book_id).name
    with _jobs_lock:
        if safe_book in _active_jobs:
            raise ValueError("Нельзя удалить учебник во время обработки")
    for path in (
        TEXTBOOK_DIR / f"{safe_book}.pdf",
        RAW_DIR / f"{safe_book}.jsonl",
        RAW_DIR / f"{safe_book}.jsonl.part",
        SECTIONS_DIR / f"{safe_book}.json",
        _meta_path(safe_book),
    ):
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
    _clear_index(safe_book)


def rebuild_missing_indexes() -> int:
    """Make old manually prepared raw datasets searchable without re-OCR."""
    rebuilt = 0
    for raw_path in RAW_DIR.glob("*.jsonl"):
        book_id = raw_path.stem
        pages = list(load_pages(book_id).values())
        if not pages:
            continue
        count = _index_count(book_id)
        if count:
            continue
        sections = _load_sections(book_id)
        _apply_sections_to_index(book_id, sections, pages)
        rebuilt += 1
    return rebuilt
