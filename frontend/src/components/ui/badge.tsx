import * as React from "react";
import { cn } from "@/lib/utils";

const Badge = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "rounded-[3px] border border-frost/20 px-1.5 py-px text-[11px] text-frost/75",
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = "Badge";

export { Badge };
