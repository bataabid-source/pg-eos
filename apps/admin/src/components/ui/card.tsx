// WBS 0.19 — minimal shadcn-style Card primitive.
import type { HTMLAttributes } from 'react';

export function Card({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-lg border border-border bg-card text-card-foreground shadow-sm ${className}`.trim()}
      {...props}
    />
  );
}

export function CardHeader({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 pb-2 ${className}`.trim()} {...props} />;
}

export function CardContent({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`p-4 pt-0 ${className}`.trim()} {...props} />;
}

export function CardFooter({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`flex gap-2 p-4 pt-2 ${className}`.trim()} {...props} />;
}
