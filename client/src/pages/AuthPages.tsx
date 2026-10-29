import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { authApi } from '../api/endpoints';
import { errorMessage, setCsrfToken } from '../api/client';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { Logo } from '../components/layout/Logo';
import { useAuth } from '../hooks/useAuth';

const loginSchema = z.object({
  email: z.string().trim().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export const passwordRule = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'Password is too long')
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'Include letters and numbers');

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Enter your name').max(80),
  email: z.string().trim().email('Enter a valid email address'),
  password: passwordRule,
});

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-50 px-4 py-10">
      <div className="w-full max-w-sm">
        <Logo className="mb-8 justify-center" />
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
          <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
          <p className="mb-6 mt-1 text-sm text-slate-500">{subtitle}</p>
          {children}
        </div>
        <p className="mt-6 text-center text-sm text-slate-600">{footer}</p>
      </div>
    </div>
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
    navigate(from && from.startsWith('/') && !from.startsWith('//') ? from : '/drive', { replace: true });
  };
}

export function LoginPage() {
  const { user } = useAuth();
  const done = useAfterAuth();
  const { register, handleSubmit, setError, formState } = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  if (user) return <Navigate to="/drive" replace />;
  const submit = handleSubmit(async (values) => {
    try {
      done(await authApi.login(values));
    } catch (err) {
      setError('root', { message: errorMessage(err) });
    }
  });
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your Cirrus drive." footer={<>New here? <Link className="font-medium text-brand-700 hover:underline" to="/register">Create an account</Link></>}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Email" type="email" autoComplete="email" {...register('email')} error={formState.errors.email?.message} />
        <Field label="Password" type="password" autoComplete="current-password" {...register('password')} error={formState.errors.password?.message} />
        {formState.errors.root && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formState.errors.root.message}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={formState.isSubmitting}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { user } = useAuth();
  const done = useAfterAuth();
  const { register, handleSubmit, setError, formState } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });
  if (user) return <Navigate to="/drive" replace />;
  const submit = handleSubmit(async (values) => {
    try {
      done(await authApi.register(values));
    } catch (err) {
      setError('root', { message: errorMessage(err) });
    }
  });
  return (
    <AuthShell title="Create your account" subtitle="Store, organise and preview your files securely." footer={<>Already have an account? <Link className="font-medium text-brand-700 hover:underline" to="/login">Sign in</Link></>}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Name" autoComplete="name" {...register('name')} error={formState.errors.name?.message} />
        <Field label="Email" type="email" autoComplete="email" {...register('email')} error={formState.errors.email?.message} />
        <Field label="Password" type="password" autoComplete="new-password" hint="At least 10 characters, with letters and numbers." {...register('password')} error={formState.errors.password?.message} />
        {formState.errors.root && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formState.errors.root.message}</p>}
        <Button type="submit" variant="primary" className="w-full" loading={formState.isSubmitting}>Create account</Button>
      </form>
    </AuthShell>
  );
}
