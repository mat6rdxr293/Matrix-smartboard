import { memo } from "react";
import { BlockMath, InlineMath } from "react-katex";

type MathFormulaProps = {
  latex: string;
  fallbackText: string;
  display?: boolean;
  className?: string;
};

function MathFormula({
  latex,
  fallbackText,
  display = true,
  className,
}: MathFormulaProps) {
  const fallback = () => (
    <span className="whitespace-pre-wrap text-inherit">{fallbackText || latex}</span>
  );

  return (
    <div className={className}>
      {display ? (
        <BlockMath math={latex} errorColor="#FFB86B" renderError={fallback} />
      ) : (
        <InlineMath math={latex} errorColor="#FFB86B" renderError={fallback} />
      )}
    </div>
  );
}

export default memo(MathFormula);
