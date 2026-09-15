import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost } from "@/app/ai/api";
import { useI18n } from "@/i18n";

function parseCoeffs(value: string): number[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => Number(v));
}

export default function AlgorithmsPanel({ onLog }: { onLog: (line: string) => void }) {
  const { tl } = useI18n();
  const [coeffs, setCoeffs] = useState("1,-4,-1,4");
  const [xValue, setXValue] = useState("4");
  const [aValue, setAValue] = useState("4");
  const [dividend, setDividend] = useState("1,0,0,0,-1");
  const [divisor, setDivisor] = useState("1,0,-1");
  const [result, setResult] = useState<string>("");
  const [table, setTable] = useState<number[]>([]);

  const handleNormalize = async () => {
    const res = await apiPost<{ coeffs: number[] }>("/api/normalize", {
      coeffs: parseCoeffs(coeffs),
    });
    const line = tl("normalized_value", { value: res.coeffs.join(", ") });
    setResult(line);
    onLog(line);
  };

  const handleEval = async () => {
    const res = await apiPost<{ value: number }>("/api/eval", {
      coeffs: parseCoeffs(coeffs),
      x: Number(xValue),
    });
    const line = tl("value_value", { value: res.value });
    setResult(line);
    onLog(line);
  };

  const handleCandidates = async () => {
    const res = await apiPost<{ candidates: number[] }>("/api/candidates", {
      coeffs: parseCoeffs(coeffs),
    });
    const line = tl("candidates_value", { value: res.candidates.join(", ") });
    setResult(line);
    onLog(line);
  };

  const handleHorner = async () => {
    const res = await apiPost<{ quotient: number[]; remainder: number; table: number[] }>(
      "/api/horner",
      {
        coeffs: parseCoeffs(coeffs),
        a: Number(aValue),
      }
    );
    const line = tl("quotient_q_remainder_r", {
      q: res.quotient.join(", "),
      r: res.remainder,
    });
    setResult(line);
    onLog(line);
    setTable(res.table);
  };

  const handleDivide = async () => {
    const res = await apiPost<{ quotient: number[]; remainder: number[] }>("/api/divide", {
      dividend: parseCoeffs(dividend),
      divisor: parseCoeffs(divisor),
    });
    const line = tl("quotient_q_remainder_r", {
      q: res.quotient.join(", "),
      r: res.remainder.join(", "),
    });
    setResult(line);
    onLog(line);
  };

  return (
    <div className="grid h-full grid-cols-[1.2fr_1fr] gap-4">
      <div className="glass rounded-2xl p-6 shadow-glass">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-frost/50">{tl("polynomial_algorithms")}</div>
            <div className="text-2xl font-semibold">{tl("verification_and_calculations")}</div>
          </div>
          <Badge>API</Badge>
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-2 text-xs uppercase tracking-wider text-frost/50">
              {tl("coefficients_high_low")}
            </div>
            <Input value={coeffs} onChange={(e) => setCoeffs(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" onClick={handleNormalize}>{tl("normalize")}</Button>
            <Button variant="outline" onClick={handleCandidates}>{tl("root_candidates")}</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input value={xValue} onChange={(e) => setXValue(e.target.value)} placeholder="x" />
            <Button variant="outline" onClick={handleEval}>{tl("calculate_p_x")}</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input value={aValue} onChange={(e) => setAValue(e.target.value)} placeholder="a" />
            <Button variant="outline" onClick={handleHorner}>{tl("horner_scheme")}</Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input value={dividend} onChange={(e) => setDividend(e.target.value)} placeholder="Dividend" />
            <Input value={divisor} onChange={(e) => setDivisor(e.target.value)} placeholder="Divisor" />
            <Button variant="outline" onClick={handleDivide}>{tl("division_of_polynomials")}</Button>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-frost/80">
            {result || tl("the_result_will_appear_here")}
          </div>
        </div>
      </div>
      <div className="glass rounded-2xl p-6 shadow-soft">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-sm font-semibold uppercase tracking-wider text-frost/70">{tl("horner_table")}</div>
          <Badge>Table</Badge>
        </div>
        {table.length === 0 ? (
          <div className="text-sm text-frost/50">{tl("draw_a_horner_diagram_to_see_the_table")}</div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {table.map((v, i) => (
              <div key={i} className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
                {tl("step_step_value", { step: i + 1, value: v })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
