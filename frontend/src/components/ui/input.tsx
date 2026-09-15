import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-10 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-frost placeholder:text-frost/40 focus:outline-none focus:ring-2 focus:ring-neon/60",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export { Input };
