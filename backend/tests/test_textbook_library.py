from __future__ import annotations

import time
from pathlib import Path

import pymupdf

import app.textbook_library as library


def _configure_tmp_library(monkeypatch, tmp_path: Path) -> None:
    data = tmp_path / "data"
    monkeypatch.setattr(library, "DATA_ROOT", data)
    monkeypatch.setattr(library, "TEXTBOOK_DIR", data / "textbooks")
    monkeypatch.setattr(library, "RAW_DIR", data / "raw")
    monkeypatch.setattr(library, "SECTIONS_DIR", data / "sections")
    monkeypatch.setattr(library, "LIBRARY_DIR", data / "library")
    monkeypatch.setattr(library, "INDEX_PATH", data / "page-index.sqlite3")
    monkeypatch.setattr(library, "_vision_ocr_available", lambda: False)


def _sample_pdf() -> bytes:
    doc = pymupdf.open()
    pages = [
        (
            "$ 1. LOGARITHMS AND THEIR PROPERTIES\n"
            "A logarithm of a positive number b to base a is defined by an exponent equality. "
            "The main logarithmic identity is used when transforming expressions. "
            "A decimal logarithm has base ten."
        ),
        (
            "This page continues the section about logarithms. "
            "Logarithm properties turn a product into a sum of logarithms "
            "and move an exponent in front of a logarithm. Several examples follow."
        ),
        (
            "$ 2. EXPONENTIAL FUNCTION\n"
            "The exponential function has the form y = a^x for a > 0 and a != 1. "
            "Its properties depend on the base. The function is used in growth models."
        ),
    ]
    for text in pages:
        page = doc.new_page(width=595, height=842)
        page.insert_textbox(pymupdf.Rect(50, 60, 545, 780), text, fontsize=12)
    payload = doc.tobytes()
    doc.close()
    return payload


def _wait_ready(book_id: str, timeout: float = 8.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        meta = library._read_meta(book_id)
        if meta and meta.get("status") in {"ready", "partial", "error"}:
            return meta
        time.sleep(0.05)
    raise AssertionError("textbook processing did not finish")


def test_pdf_ingestion_builds_sections_and_page_index(monkeypatch, tmp_path):
    _configure_tmp_library(monkeypatch, tmp_path)

    queued = library.enqueue_textbook("Алгебра 11.pdf", _sample_pdf())
    book_id = queued["id"]
    meta = _wait_ready(book_id)

    assert meta["status"] == "ready"
    assert meta["totalPages"] == 3
    assert meta["indexedPages"] == 3
    assert meta["searchReady"] is True

    catalog = library.list_textbooks()
    book = next(item for item in catalog["books"] if item["id"] == book_id)
    assert book["sections"][0]["id"] == "1"
    assert book["sections"][0]["pageStart"] == 1
    assert any(item["id"] == "2" for item in book["sections"])

    hits = library.search_pages(book_id, "logarithm", limit=4)
    assert hits
    assert hits[0]["page"] in {1, 2}
    assert "logarith" in hits[0]["excerpt"].lower()

    context, pages = library.search_context(book_id, "exponential function", limit=3)
    assert 3 in pages
    assert "exponential function" in context.lower()


def test_same_pdf_is_deduplicated(monkeypatch, tmp_path):
    _configure_tmp_library(monkeypatch, tmp_path)
    payload = _sample_pdf()

    first = library.enqueue_textbook("Алгебра 11.pdf", payload)
    _wait_ready(first["id"])
    second = library.enqueue_textbook("Другая копия.pdf", payload)

    assert second["id"] == first["id"]
    assert len(library.list_textbooks()["books"]) == 1
