import pytest

from app.curriculum import is_subject_allowed, subjects_for_grade


def test_subjects_change_at_grade_boundaries():
    assert subjects_for_grade(2) == (
        "math",
        "natural_science",
        "kazakh",
        "russian",
    )
    assert subjects_for_grade(3) == (
        "math",
        "natural_science",
        "kazakh",
        "russian",
        "english",
    )
    assert "natural_science" in subjects_for_grade(6)
    assert subjects_for_grade(7) == (
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


def test_subject_validation_rejects_wrong_grade_pair():
    assert is_subject_allowed(6, "natural_science") is True
    assert is_subject_allowed(6, "physics") is False
    assert is_subject_allowed(7, "physics") is True
    assert is_subject_allowed(7, "natural_science") is False


@pytest.mark.parametrize("grade", [0, 12])
def test_invalid_grade_is_rejected(grade: int):
    with pytest.raises(ValueError, match="between 1 and 11"):
        subjects_for_grade(grade)
