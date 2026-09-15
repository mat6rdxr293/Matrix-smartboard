from __future__ import annotations


PRIMARY_SUBJECTS = (
    "math",
    "natural_science",
    "kazakh",
    "russian",
)

PRIMARY_WITH_ENGLISH_SUBJECTS = PRIMARY_SUBJECTS + ("english",)

SECONDARY_SUBJECTS = (
    "algebra",
    "geometry",
    "physics",
    "chemistry",
    "biology",
    "geography",
    "kazakh",
    "russian",
    "english",
)


def subjects_for_grade(grade: int) -> tuple[str, ...]:
    if not 1 <= grade <= 11:
        raise ValueError("grade must be between 1 and 11")
    if grade <= 2:
        return PRIMARY_SUBJECTS
    if grade <= 6:
        return PRIMARY_WITH_ENGLISH_SUBJECTS
    return SECONDARY_SUBJECTS


def is_subject_allowed(grade: int, subject_id: str) -> bool:
    try:
        return subject_id in subjects_for_grade(grade)
    except ValueError:
        return False
