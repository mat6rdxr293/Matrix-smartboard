from app.polynomial import candidates, divide, eval_poly, horner


def test_horner():
    coeffs = [1, -4, -1, 4]
    q, r = horner(coeffs, 4)
    assert r == 0
    assert q == [1, 0, -1]


def test_divide():
    q, r = divide([1, 0, 0, 0, -1], [1, 0, -1])
    assert q == [1, 0, 1]
    assert r == [0]


def test_candidates():
    cands = candidates([1, -3, -4])
    assert -4 in cands
    assert 4 in cands
    assert 1 in cands


def test_eval():
    assert eval_poly([1, -4, -1, 4], 4) == 0
