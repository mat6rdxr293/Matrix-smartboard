"""Временный SFT-датасет (50 пар kk/ru/en) для проверки конвейера обучения.

Не пересекается с benchmark/questions.jsonl. Когда появятся настоящие данные, заменить.
    python scripts/make_test_sft.py  →  data/sft/train.jsonl
"""
import json
from pathlib import Path

from prompts import SYSTEM_PROMPT

ROOT = Path(__file__).resolve().parent.parent

PAIRS = {
    "kk": [
        ("Қазақстанның астанасы қай қала?", "Астана."),
        ("Абай Құнанбайұлы қай жылы туған?", "1845 жылы."),
        ("«Қара сөздердің» авторы кім?", "Абай Құнанбайұлы."),
        ("Жасушаның тұқым қуалау ақпаратын сақтайтын органоиды қалай аталады?", "Ядро."),
        ("Қанның қызыл түйіршіктері қалай аталады?", "Эритроциттер."),
        ("Адам жүрегі неше камерадан тұрады?", "Төрт камерадан: екі жүрекше және екі қарынша."),
        ("Заттың тығыздығы қалай есептеледі?", "ρ = m/V — массаның көлемге қатынасы."),
        ("Қуаттың ХБЖ-дағы өлшем бірлігі қандай?", "Ватт (Вт)."),
        ("Архимед күші дегеніміз не?", "Сұйыққа батырылған денеге әсер ететін, ығыстырылған сұйықтың салмағына тең, жоғары бағытталған күш."),
        ("Қазақстан БҰҰ-ға қашан мүше болды?", "1992 жылғы 2 наурызда."),
        ("Тәуке ханның заңдар жинағы қалай аталады?", "«Жеті жарғы»."),
        ("Фотосинтез кезінде қандай газ бөлінеді?", "Оттегі."),
        ("Қазақстанның тұңғыш ғарышкері кім?", "Тоқтар Әубәкіров (1991 жыл)."),
        ("Дыбыстың ауадағы жылдамдығы шамамен қандай?", "Шамамен 340 м/с (20 °C кезінде 343 м/с)."),
        ("Жер бетінен h биіктікке көтерілген дененің потенциалдық энергиясы қалай есептеледі?", "Eп = mgh."),
        ("Ферменттер дегеніміз не?", "Жасушадағы химиялық реакцияларды жылдамдататын биологиялық катализаторлар, көбіне ақуыздар."),
        ("Шоқан Уәлиханов кім болған?", "XIX ғасырдағы қазақ ғалымы, тарихшы, этнограф және саяхатшы."),
    ],
    "ru": [
        ("Сколько хромосом в половой клетке человека?", "23 хромосомы (гаплоидный набор)."),
        ("Кто сформулировал закон всемирного тяготения?", "Исаак Ньютон."),
        ("В каких единицах измеряется электрический заряд в СИ?", "В кулонах (Кл)."),
        ("Сформулируйте первый закон термодинамики.", "Количество теплоты, переданное системе, идёт на изменение её внутренней энергии и совершение работы: Q = ΔU + A."),
        ("Что такое ген?", "Участок ДНК, несущий информацию об одном белке или молекуле РНК."),
        ("Какой газ поглощают растения при фотосинтезе?", "Углекислый газ (CO₂)."),
        ("Как называется наука о наследственности и изменчивости?", "Генетика."),
        ("Кто возглавил последнее крупное национально-освободительное восстание казахов в 1837–1847 годах?", "Кенесары Касымов."),
        ("В каком году было основано укрепление Верное (ныне Алматы)?", "В 1854 году."),
        ("На какие жузы делились казахи?", "Старший, Средний и Младший жузы."),
        ("По какой формуле вычисляется импульс тела?", "p = mv."),
        ("Что такое изотопы?", "Атомы одного химического элемента с одинаковым числом протонов, но разным числом нейтронов."),
        ("Какова частота переменного тока в электросети Казахстана?", "50 Гц."),
        ("Где происходит газообмен в лёгких?", "В альвеолах."),
        ("Как называются организмы, клетки которых не имеют оформленного ядра?", "Прокариоты (бактерии и археи)."),
        ("Кто был первым президентом Республики Казахстан?", "Нурсултан Назарбаев."),
        ("Какие величины измеряются в джоулях?", "Энергия, работа и количество теплоты."),
    ],
    "en": [
        ("What is osmosis?", "The diffusion of water across a semi-permeable membrane from a dilute solution to a more concentrated one."),
        ("What is the SI unit of frequency?", "The hertz (Hz)."),
        ("State Newton's third law.", "For every action there is an equal and opposite reaction."),
        ("What is the capital of Kazakhstan?", "Astana."),
        ("What is the national currency of Kazakhstan?", "The tenge, introduced on 15 November 1993."),
        ("Who wrote the Book of Words (Qara sozder)?", "Abai Qunanbaiuly."),
        ("What is the chemical formula of water?", "H₂O."),
        ("Which organelle contains most of the DNA in a eukaryotic cell?", "The nucleus."),
        ("How is density calculated?", "Density = mass / volume (ρ = m/V)."),
        ("What is an ecosystem?", "A community of living organisms interacting with each other and with their physical environment."),
        ("What is the speed of sound in air?", "About 343 m/s at 20 °C."),
        ("What is DNA replication?", "The copying of a DNA molecule before cell division; it is semi-conservative."),
        ("What are the three common states of matter?", "Solid, liquid and gas."),
        ("In which city is the Mausoleum of Khoja Ahmed Yasawi located?", "Turkistan, in southern Kazakhstan."),
        ("Write the overall equation of photosynthesis.", "6CO₂ + 6H₂O → C₆H₁₂O₆ + 6O₂ (in the presence of light and chlorophyll)."),
        ("What is a vector quantity?", "A quantity that has both magnitude and direction, such as velocity or force."),
    ],
}


def main():
    out = ROOT / "data" / "sft" / "train.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with open(out, "w", encoding="utf-8") as f:
        for lang, pairs in PAIRS.items():
            for q, a in pairs:
                rec = {"lang": lang, "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT[lang]},
                    {"role": "user", "content": q},
                    {"role": "assistant", "content": a},
                ]}
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                n += 1
    print(f"{n} примеров → {out}")


if __name__ == "__main__":
    main()
