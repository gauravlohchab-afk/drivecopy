import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export const Field = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string; trailing?: ReactNode }
>(function Field({ label, error, hint, trailing, id, ...rest }, ref) {
  const inputId = id ?? rest.name;
  return (
    <div>
      <label htmlFor={inputId} className="label">{label}</label>
      <div className="relative">
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={clsx('input focus-ring', trailing && 'pr-11')}
          {...rest}
        />
        {trailing && <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div>}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="field-error">{error}</p>
      ) : hint ? (
        <p id={`${inputId}-hint`} className="field-hint">{hint}</p>
      ) : null}
    </div>
  );
});
