import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { AlertCircle, ArrowRight, Eye, EyeOff, FileImage, FileText, Folder } from 'lucide-react';
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

const sampleFiles = [
  { icon: Folder, name: 'Projects', meta: '12 items', tint: 'bg-amber-100 text-amber-600' },
  { icon: FileImage, name: 'beach-sunset.jpg', meta: '3.2 MB', tint: 'bg-sky-100 text-sky-600' },
  { icon: FileText, name: 'Q3-report.pdf', meta: '840 KB', tint: 'bg-rose-100 text-rose-600' },
];

function BrandPanel() {
  return (
    <aside className="relative hidden overflow-hidden bg-gradient-to-br from-brand-600 via-brand-700 to-brand-900 p-10 text-white lg:flex lg:flex-col xl:p-12">
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-brand-400/30 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-32 -left-20 size-[28rem] rounded-full bg-fuchsia-400/20 blur-3xl" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(white_1px,transparent_1px)] [background-size:22px_22px]"
      />

      <Logo tone="light" className="relative" />

      <div className="relative my-auto max-w-md py-8">
        <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">
          All your files, <span className="text-brand-200">one calm place.</span>
        </h2>
        <p className="mt-4 text-base text-brand-100/90">Upload, organise and preview everything you keep, from any device.</p>

        <div className="mt-8 rounded-2xl border border-white/15 bg-white/10 p-4 shadow-2xl shadow-slate-950/30 backdrop-blur-md [@media(max-height:600px)]:hidden">
          <div className="mb-3 flex items-center gap-1.5 px-1" aria-hidden>
            <span className="size-2.5 rounded-full bg-white/30" />
            <span className="size-2.5 rounded-full bg-white/30" />
            <span className="size-2.5 rounded-full bg-white/30" />
          </div>
          <ul className="space-y-2" aria-hidden>
            {sampleFiles.map(({ icon: Icon, name, meta, tint }) => (
              <li key={name} className="flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 text-slate-800 shadow-sm">
                <span className={`flex size-9 items-center justify-center rounded-lg ${tint}`}><Icon className="size-5" /></span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
                <span className="text-xs text-slate-500">{meta}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 rounded-xl bg-white/10 px-3 py-2.5">
            <div className="flex items-center justify-between text-xs text-brand-100">
              <span>Uploading holiday-video.mp4</span>
              <span>68%</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/20">
              <div className="h-full w-[68%] rounded-full bg-white" />
            </div>
          </div>
        </div>

      </div>

      <p className="relative text-xs text-brand-200/80">© {new Date().getFullYear()} Cirrus</p>
    </aside>
  );
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-white lg:h-dvh lg:overflow-hidden lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />
      <main className="relative flex items-center justify-center px-4 py-10 sm:px-8 lg:overflow-y-auto">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-brand-50 to-transparent lg:hidden" />
        <div className="relative w-full max-w-sm animate-pop-in">
          <Logo className="mb-10 justify-center lg:hidden" />
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          <p className="mb-8 mt-2 text-sm text-slate-500">{subtitle}</p>
          {children}
          <p className="mt-8 border-t border-slate-100 pt-6 text-center text-sm text-slate-600">{footer}</p>
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
          className="focus-ring flex size-9 items-center justify-center rounded-md text-slate-400 transition-colors hover:text-slate-600"
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
    <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2.5 text-sm text-red-700">
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
    <AuthShell title="Welcome back" subtitle="Sign in to your Cirrus drive." footer={<>New here? <Link className="font-medium text-brand-700 hover:underline" to="/register">Create an account</Link></>}>
      <form onSubmit={submit} noValidate className="space-y-5">
        <Field label="Email" type="email" autoComplete="email" {...register('email')} error={formState.errors.email?.message} />
        <PasswordField label="Password" autoComplete="current-password" {...register('password')} error={formState.errors.password?.message} />
        <FormError message={formState.errors.root?.message} />
        <Button type="submit" variant="primary" className="h-11 w-full" loading={formState.isSubmitting}>Sign in{!formState.isSubmitting && <ArrowRight className="size-4" aria-hidden />}</Button>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { user } = useAuth();
  const done = useAfterAuth();
  const { register, handleSubmit, setError, formState } = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });
  if (user) return <Navigate to="/home" replace />;
  const submit = handleSubmit(async (values) => {
    try {
      done(await authApi.register(values));
    } catch (err) {
      setError('root', { message: errorMessage(err) });
    }
  });
  return (
    <AuthShell title="Create your account" subtitle="Store, organise and preview your files securely." footer={<>Already have an account? <Link className="font-medium text-brand-700 hover:underline" to="/login">Sign in</Link></>}>
      <form onSubmit={submit} noValidate className="space-y-5">
        <Field label="Name" autoComplete="name" {...register('name')} error={formState.errors.name?.message} />
        <Field label="Email" type="email" autoComplete="email" {...register('email')} error={formState.errors.email?.message} />
        <PasswordField label="Password" autoComplete="new-password" hint="At least 10 characters, with letters and numbers." {...register('password')} error={formState.errors.password?.message} />
        <FormError message={formState.errors.root?.message} />
        <Button type="submit" variant="primary" className="h-11 w-full" loading={formState.isSubmitting}>Create account{!formState.isSubmitting && <ArrowRight className="size-4" aria-hidden />}</Button>
      </form>
    </AuthShell>
  );
}
