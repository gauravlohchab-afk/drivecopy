import { forwardRef, type InputHTMLAttributes } from 'react';

export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }>(
  function Field({ label, error, hint, id, ...rest }, ref) {
    const inputId = id ?? rest.name;
    return (
      <div>
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">{label}</label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className="focus-ring h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm aria-[invalid=true]:border-red-400"
          {...rest}
        />
        {error ? (
          <p id={`${inputId}-error`} className="mt-1.5 text-sm text-red-600">{error}</p>
        ) : hint ? (
          <p id={`${inputId}-hint`} className="mt-1.5 text-xs text-slate-500">{hint}</p>
        ) : null}
      </div>
    );
  },
);
