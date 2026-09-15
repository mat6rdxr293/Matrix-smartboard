import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "ghost" | "accent";
  size?: "sm" | "md" | "lg";
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => {
    const variants = {
      default: "bg-frost text-ink hover:bg-white",
      outline: "border border-white/20 text-frost hover:border-white/40",
      ghost: "text-frost/80 hover:text-frost hover:bg-white/10",
      accent: "bg-accent text-ink hover:bg-neon",
    };
    const sizes = {
      sm: "h-8 px-3 text-xs",
      md: "h-10 px-4 text-sm",
      lg: "h-12 px-5 text-base",
    };
    return (
      <button
        ref={ref}
        className={cn(
          "rounded-lg font-semibold transition",
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button };
