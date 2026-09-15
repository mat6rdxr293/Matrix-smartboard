import * as React from "react";
import { cn } from "@/lib/utils";

const Badge = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-frost/80",
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = "Badge";

export { Badge };
