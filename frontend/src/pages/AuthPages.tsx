import { Navigate, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Eye, EyeOff } from 'lucide-react';
import { authApi } from '../api/endpoints';
import { errorMessage, setCsrfToken } from '../api/client';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Logo } from '../components/layout/Logo';
import { useAuth } from '../hooks/useAuth';

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username or email'),
  password: z.string().min(1, 'Enter your password'),
});

const facts = [
  ['Your own storage', 'Files are kept in Amazon S3, with no fixed storage limit in the app.'],
  ['Private by default', 'Files stay in your own S3 bucket and open through short-lived links.'],
  ['Activity', 'See what was uploaded, moved, shared or deleted, and when.'],
];

function BrandPanel() {
  return (
    <aside className="hidden flex-col justify-between bg-brand-800 p-10 text-white lg:flex xl:p-12">
      <Logo tone="light" />
      <div className="max-w-md">
        <h2 className="text-3xl font-semibold leading-snug">Your team’s files, stored in your own cloud.</h2>
        <dl className="mt-8 divide-y divide-white/15 border-y border-white/15">
          {facts.map(([term, detail]) => (
            <div key={term} className="py-3">
              <dt className="text-sm font-semibold">{term}</dt>
              <dd className="mt-0.5 text-sm text-brand-100">{detail}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="text-xs text-brand-200">© {new Date().getFullYear()} Ageless Datahub</p>
    </aside>
  );
}

function AuthShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-surface lg:h-dvh lg:overflow-hidden lg:grid-cols-2">
      <BrandPanel />
      <main className="flex items-center justify-center px-4 py-10 sm:px-8 lg:overflow-y-auto">
        <div className="w-full max-w-sm">
          <Logo className="mb-10 justify-center lg:hidden" />
          <h1 className="text-2xl font-semibold text-ink-strong">{title}</h1>
          <p className="mb-8 mt-2 text-sm text-ink-muted">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}

function PasswordField(props: Omit<ComponentProps<typeof Field>, 'type' | 'trailing'>) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <Field
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="icon-btn focus-ring"
        >
          <Icon className="size-4" aria-hidden />
        </button>
      }
    />
  );
}

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="alert alert-error">
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function useAfterAuth() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;
  return (res: { user: unknown; csrfToken: string }) => {
    setCsrfToken(res.csrfToken);
    qc.setQueryData(['me'], res.user);
    navigate(from && from.startsWith('/') && !from.startsWith('//') ? from : '/home', { replace: true });
  };
}

export function LoginPage() {
  const { user } = useAuth();
  const done = useAfterAuth();
  const { register, handleSubmit, setError, formState } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  if (user) return <Navigate to="/home" replace />;
  const submit = handleSubmit(async (values) => {
    try {
      done(await authApi.login(values));
    } catch (err) {
      setError('root', { message: errorMessage(err) });
    }
  });
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Ageless Datahub drive.">
      <form onSubmit={submit} noValidate className="space-y-5">
        <Field label="Username or email" autoComplete="username" {...register('username')} error={formState.errors.username?.message} />
        <PasswordField label="Password" autoComplete="current-password" {...register('password')} error={formState.errors.password?.message} />
        <FormError message={formState.errors.root?.message} />
        <Button type="submit" variant="primary" className="h-11 w-full" loading={formState.isSubmitting}>Sign in{!formState.isSubmitting && <ArrowRight className="size-4" aria-hidden />}</Button>
      </form>
    </AuthShell>
  );
}
