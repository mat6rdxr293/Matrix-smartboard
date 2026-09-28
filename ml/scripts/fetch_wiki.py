"""Временный корпус для проверки RAG: статьи казахской и русской Википедии по темам бенчмарка.

    python scripts/fetch_wiki.py  →  data/wiki_test/<lang>_<title>.json + data/wiki_test/README.md

Тексты — Википедия, лицензия CC BY-SA 4.0 (см. README в папке). Использовать только для тестов,
в модель и на доску не поставлять. Поиск идёт по запросу, берётся первая статья из выдачи.
"""
import json
import re
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "wiki_test"
UA = "MatrixSmartboard-ML/0.1 (school assistant research; python-requests)"

# (язык, поисковый запрос, id вопросов бенчмарка, на которые статья отвечает)
TOPICS = [
    ("kk", "Қазақ хандығы", ["kk-hist-001"]),
    ("kk", "Аңырақай шайқасы", ["kk-hist-002"]),
    ("kk", "Алаш Орда", ["kk-hist-003"]),
    ("kk", "Қазақстан Республикасының Тәуелсіздік күні", ["kk-hist-004", "en-hist-022"]),
    ("kk", "Фотосинтез", ["kk-biol-005"]),
    ("kk", "Хромосомалар", ["kk-biol-006"]),
    ("kk", "Дезоксирибонуклеин қышқылы", ["kk-biol-007"]),
    ("kk", "Митохондрия", ["kk-biol-008"]),
    ("kk", "Ньютон заңдары", ["kk-phys-009"]),
    ("kk", "Жарық жылдамдығы", ["kk-phys-010"]),
    ("kk", "Ом заңы", ["kk-phys-011"]),
    ("kk", "Еркін түсу үдеуі", ["kk-phys-012"]),
    ("kk", "Желтоқсан көтерілісі", ["ru-hist-015"]),
    ("ru", "Конституция Казахстана", ["ru-hist-013"]),
    ("ru", "Перенос столицы Казахстана", ["ru-hist-014"]),
    ("ru", "Декабрьские события в Алма-Ате (1986)", ["ru-hist-015"]),
    ("ru", "Мейоз", ["ru-biol-016"]),
    ("ru", "Законы Менделя", ["ru-biol-017"]),
    ("ru", "Рибосома", ["ru-biol-018"]),
    ("ru", "Ньютон (единица измерения)", ["ru-phys-019"]),
    ("ru", "Кинетическая энергия", ["ru-phys-020"]),
    ("ru", "Период полураспада", ["ru-phys-021"]),
    ("ru", "Байконур космодром", ["en-hist-023"]),
    ("ru", "Семипалатинский испытательный ядерный полигон", ["en-hist-024"]),
    ("ru", "Транспортная РНК", ["en-biol-025"]),
    ("ru", "Гемоглобин", ["en-biol-026"]),
    ("ru", "Артерия", ["en-biol-027"]),
    ("ru", "Ом (единица измерения)", ["en-phys-028"]),
    ("ru", "Закон сохранения энергии", ["en-phys-029"]),
    ("ru", "Ватт", ["en-phys-030"]),
]

README = """# data/wiki_test — временный тестовый корпус

Статьи казахской (kk.wikipedia.org) и русской (ru.wikipedia.org) Википедии по темам бенчмарка.
Нужны только для проверки RAG-конвейера, пока нет учебников.

**Лицензия:** тексты Википедии распространяются по лицензии
[Creative Commons Attribution-ShareAlike 4.0 (CC BY-SA 4.0)](https://creativecommons.org/licenses/by-sa/4.0/).
Авторы — участники Википедии; история правок каждой статьи — по ссылке в поле `url` (+ `?action=history`).
Для каждой статьи сохранены `url` и `revid` — ревизия, с которой снят текст.
При распространении (в т.ч. в составе индекса или модели) нужно указать авторство и сохранить лицензию.
Не использовать как обучающие данные для модели на доске без отдельного решения по лицензии.

| Язык | Статья | revid | Вопросы бенчмарка |
|---|---|---|---|
"""


def get_json(s, url, params, tries=6):
    """GET с уважением к лимитам Wikimedia: пауза между запросами и повтор по 429/5xx."""
    for i in range(tries):
        time.sleep(1.5)
        r = s.get(url, params=params, timeout=30)
        if r.status_code == 200:
            return r.json()
        wait = int(r.headers.get("retry-after", 0) or 0) or 5 * 2 ** i
        print(f"  HTTP {r.status_code}, жду {wait}s")
        time.sleep(wait)
    r.raise_for_status()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    s = requests.Session()
    s.headers["User-Agent"] = UA
    # уже скачанные статьи (по поисковому запросу) не перекачиваем
    done = {}
    for fp in OUT.glob("*.json"):
        rec = json.loads(fp.read_text(encoding="utf-8"))
        done[(rec["lang"], rec["query"])] = rec
    rows, failed = [], []
    for lang, query, qids in TOPICS:
        if (lang, query) in done:
            rows.append(done[(lang, query)])
            continue
        api = f"https://{lang}.wikipedia.org/w/api.php"
        hits = get_json(s, api, dict(action="query", list="search", srsearch=query, srlimit=1, format="json"))["query"]["search"]
        if not hits:
            failed.append((lang, query))
            continue
        title = hits[0]["title"]
        data = get_json(s, api, dict(action="query", prop="extracts|info|revisions", explaintext=1, inprop="url",
                                     rvprop="ids", titles=title, redirects=1, format="json"))
        page = next(iter(data["query"]["pages"].values()))
        text = page.get("extract", "").strip()
        if len(text) < 200:
            failed.append((lang, query))
            continue
        rec = {"lang": lang, "title": page["title"], "url": page["fullurl"],
               "revid": page["revisions"][0]["revid"], "license": "CC BY-SA 4.0",
               "query": query, "bench_ids": qids, "text": text}
        fname = OUT / (f"{lang}_" + re.sub(r"[^\w\-]+", "_", page["title"])[:80] + ".json")
        fname.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        rows.append(rec)
        print(f"{lang}: {query!r} → {page['title']!r} ({len(text)} симв.)")

    with open(OUT / "README.md", "w", encoding="utf-8") as f:
        f.write(README)
        for r in rows:
            f.write(f"| {r['lang']} | [{r['title']}]({r['url']}) | {r['revid']} | {', '.join(r['bench_ids'])} |\n")
    print(f"\nСохранено {len(rows)} статей в {OUT}")
    if failed:
        print("Не найдено:", failed)


if __name__ == "__main__":
    main()
