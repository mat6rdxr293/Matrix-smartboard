from __future__ import annotations

from dataclasses import dataclass
from math import gcd
from typing import List, Tuple


Number = float | int


def normalize(coeffs: List[Number]) -> List[Number]:
    if not coeffs:
        return [0]
    i = 0
    while i < len(coeffs) - 1 and coeffs[i] == 0:
        i += 1
    return coeffs[i:]


def eval_poly(coeffs: List[Number], x: Number) -> Number:
    result: Number = 0
    for c in coeffs:
        result = result * x + c
    return result


def _factors(n: int) -> List[int]:
    n = abs(n)
    if n == 0:
        return [0]
    factors = set()
    for i in range(1, int(n ** 0.5) + 1):
        if n % i == 0:
            factors.add(i)
            factors.add(n // i)
    return sorted(factors)


def candidates(coeffs: List[int]) -> List[float]:
    coeffs = normalize(coeffs)
    if len(coeffs) <= 1:
        return []
    lead = int(coeffs[0])
    const = int(coeffs[-1])
    if lead == 0:
        return []
    p_factors = _factors(const)
    q_factors = _factors(lead)
    cands = set()
    for p in p_factors:
        for q in q_factors:
            if q == 0:
                continue
            value = p / q
            cands.add(value)
            cands.add(-value)
    return sorted(cands)


def horner(coeffs: List[Number], a: Number) -> Tuple[List[Number], Number]:
    coeffs = normalize(coeffs)
    if len(coeffs) <= 1:
        return [0], coeffs[0] if coeffs else 0
    out: List[Number] = []
    acc = coeffs[0]
    out.append(acc)
    for c in coeffs[1:]:
        acc = acc * a + c
        out.append(acc)
    remainder = out.pop()
    return normalize(out), remainder


def divide(dividend: List[Number], divisor: List[Number]) -> Tuple[List[Number], List[Number]]:
    dividend = normalize(dividend)
    divisor = normalize(divisor)
    if divisor == [0]:
        raise ValueError("Division by zero polynomial")
    if len(dividend) < len(divisor):
        return [0], dividend

    quotient = [0] * (len(dividend) - len(divisor) + 1)
    remainder = dividend[:]

    divisor_lead = divisor[0]
    for i in range(len(quotient)):
        idx = i
        if remainder[idx] == 0:
            q = 0
        else:
            q = remainder[idx] / divisor_lead
        quotient[i] = q
        for j in range(len(divisor)):
            remainder[idx + j] -= q * divisor[j]

    remainder = normalize(remainder[-(len(divisor) - 1):]) if len(divisor) > 1 else [0]
    return normalize(quotient), remainder


@dataclass
class HornerStep:
    value: Number


def horner_table(coeffs: List[Number], a: Number) -> List[HornerStep]:
    coeffs = normalize(coeffs)
    steps: List[HornerStep] = []
    acc: Number = 0
    for c in coeffs:
        acc = acc * a + c
        steps.append(HornerStep(value=acc))
    return steps
