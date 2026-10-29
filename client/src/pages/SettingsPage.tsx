import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { authApi } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Button } from '../components/ui/Button';
import { Field } from '../components/ui/Field';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../hooks/useAuth';
import { StorageMeter } from '../components/layout/StorageMeter';
import { passwordRule } from './AuthPages';

const profileSchema = z.object({ name: z.string().trim().min(1, 'Enter your name').max(80) });
const passwordSchema = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: passwordRule, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords don’t match' });

export function SettingsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  const profile = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema), values: { name: user?.name ?? '' } });
  const password = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });

  const saveProfile = profile.handleSubmit(async (v) => {
    try {
      const res = await authApi.updateProfile(v);
      qc.setQueryData(['me'], res.user);
      toast({ kind: 'success', message: 'Profile updated' });
    } catch (err) {
      profile.setError('root', { message: errorMessage(err) });
    }
  });

  const savePassword = password.handleSubmit(async (v) => {
    try {
      await authApi.changePassword({ currentPassword: v.currentPassword, newPassword: v.newPassword });
      password.reset({ currentPassword: '', newPassword: '', confirm: '' });
      toast({ kind: 'success', message: 'Password changed. Other devices were signed out.' });
    } catch (err) {
      password.setError('currentPassword', { message: errorMessage(err) });
    }
  });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold text-slate-900">Settings</h1>
      <section className="mb-6 rounded-xl border border-slate-200 p-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Profile</h2>
        <form onSubmit={saveProfile} noValidate className="space-y-4">
          <Field label="Name" autoComplete="name" {...profile.register('name')} error={profile.formState.errors.name?.message ?? profile.formState.errors.root?.message} />
          <Field label="Email" value={user?.email ?? ''} readOnly disabled />
          <Button type="submit" variant="primary" loading={profile.formState.isSubmitting}>Save profile</Button>
        </form>
      </section>
      <section className="mb-6 rounded-xl border border-slate-200 p-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Change password</h2>
        <form onSubmit={savePassword} noValidate className="space-y-4">
          <Field label="Current password" type="password" autoComplete="current-password" {...password.register('currentPassword')} error={password.formState.errors.currentPassword?.message} />
          <Field label="New password" type="password" autoComplete="new-password" hint="At least 10 characters, with letters and numbers." {...password.register('newPassword')} error={password.formState.errors.newPassword?.message} />
          <Field label="Confirm new password" type="password" autoComplete="new-password" {...password.register('confirm')} error={password.formState.errors.confirm?.message} />
          <Button type="submit" variant="primary" loading={password.formState.isSubmitting}>Change password</Button>
        </form>
      </section>
      <section className="rounded-xl border border-slate-200 p-5">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Storage</h2>
        <StorageMeter />
        <p className="mt-3 text-xs text-slate-500">Files in Trash count toward your storage until they are deleted forever.</p>
      </section>
    </div>
  );
}
