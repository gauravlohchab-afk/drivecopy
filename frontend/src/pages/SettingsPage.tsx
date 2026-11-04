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
import { StorageInfo } from '../components/layout/StorageInfo';

const profileSchema = z.object({ name: z.string().trim().min(1, 'Enter your name').max(80) });

export function SettingsPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  const profile = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema), values: { name: user?.name ?? '' } });

  const saveProfile = profile.handleSubmit(async (v) => {
    try {
      const res = await authApi.updateProfile(v);
      qc.setQueryData(['me'], res.user);
      toast({ kind: 'success', message: 'Profile updated' });
    } catch (err) {
      profile.setError('root', { message: errorMessage(err) });
    }
  });

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-6 text-xl font-semibold text-ink-strong">Settings</h1>
      <section className="card card-body mb-6">
        <h2 className="card-title mb-4 text-base">Profile</h2>
        <form onSubmit={saveProfile} noValidate className="space-y-4">
          <Field label="Name" autoComplete="name" {...profile.register('name')} error={profile.formState.errors.name?.message ?? profile.formState.errors.root?.message} />
          <Field label="Username" value={user?.email ?? ''} readOnly disabled />
          <Button type="submit" variant="primary" loading={profile.formState.isSubmitting}>Save profile</Button>
        </form>
      </section>
      <section className="card card-body mb-6">
        <h2 className="card-title mb-2 text-base">Sign-in</h2>
        <p className="text-sm text-ink-muted">
          The username and password are set on the server. To change them, update the backend environment and restart it. That also signs out every device.
        </p>
      </section>
      <section className="rounded-card border border-line p-5">
        <StorageInfo />
        <p className="mt-3 px-1 text-xs text-ink-muted">Files in Trash stay in S3 until they are deleted forever.</p>
      </section>
    </div>
  );
}
