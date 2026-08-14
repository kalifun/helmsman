// 职责：Button —— fill（primary）/ plain / quiet / icon / mini 五种变体（原型 .btn 体系）。
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'plain' | 'quiet' | 'icon' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  mini?: boolean;
  children?: ReactNode;
}

export function Button({ variant, mini, className = '', children, ...rest }: ButtonProps) {
  const cls = ['btn', variant === 'primary' ? 'primary' : variant === 'plain' ? 'plain' : variant === 'quiet' ? 'quiet' : variant === 'icon' ? 'icon' : variant === 'ghost' ? 'ghost' : '', mini ? 'mini' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
