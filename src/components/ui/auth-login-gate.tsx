import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ArrowLeft, Lock, Mail } from 'lucide-react';

import { authFormDefaultGooglePrimary, authFormDefaultSecondaryGithub } from '@/components/ui/sign-in-1';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type Step = 'signin' | 'signup';

const COMPASS_TERMS_URL = 'https://compass.ivesdeu.com/terms';
const COMPASS_PRIVACY_URL = 'https://compass.ivesdeu.com/privacy';

function authEmailRedirectTo() {
  try {
    return (window.location.href || '').split('#')[0];
  } catch {
    return `${window.location.origin || ''}/`;
  }
}

function readRecoveryFlag(): boolean {
  try {
    const w = window as Window & { __bizdashIsAuthRecoveryMode?: () => boolean };
    return w.__bizdashIsAuthRecoveryMode?.() === true;
  } catch {
    return false;
  }
}

function setMainAuthError(msg: string) {
  const el = document.getElementById('gate-auth-error');
  if (el) el.textContent = msg || '';
}

function setSignupEmailDeliverabilityHint(visible: boolean) {
  const hint = document.getElementById('gate-signup-email-hint');
  const btnR = document.getElementById('gate-resend-confirm');
  const dis = visible ? '' : 'none';
  if (hint) hint.style.display = dis;
  if (btnR) btnR.style.display = dis;
}

function syncSignupEmailToMainGate(email: string) {
  const main = document.getElementById('gate-email') as HTMLInputElement | null;
  if (main) main.value = email;
}

export function AuthLoginGate() {
  const [step, setStep] = useState<Step>('signin');
  const [recoveryMode, setRecoveryMode] = useState(readRecoveryFlag);

  const [signupFirst, setSignupFirst] = useState('');
  const [signupLast, setSignupLast] = useState('');
  const [signupCompany, setSignupCompany] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');
  const [signupError, setSignupError] = useState('');
  const [signupSubmitting, setSignupSubmitting] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(true);

  useLayoutEffect(() => {
    if (readRecoveryFlag()) setStep('signin');
  }, []);

  useLayoutEffect(() => {
    if (step !== 'signin') return;
    window.dispatchEvent(new CustomEvent('bizdash-auth-email-mounted'));
  }, [step]);

  useEffect(() => {
    const onRecovery = (e: Event) => {
      const ce = e as CustomEvent<{ on?: boolean }>;
      if (!ce.detail || typeof ce.detail.on !== 'boolean') return;
      setRecoveryMode(ce.detail.on);
      if (ce.detail.on) setStep('signin');
    };
    const onLoggedOut = () => {
      setRecoveryMode(false);
      setStep('signin');
    };
    window.addEventListener('bizdash-auth-recovery-mode', onRecovery as EventListener);
    window.addEventListener('bizdash-auth-logged-out', onLoggedOut);
    return () => {
      window.removeEventListener('bizdash-auth-recovery-mode', onRecovery as EventListener);
      window.removeEventListener('bizdash-auth-logged-out', onLoggedOut);
    };
  }, []);

  useEffect(() => {
    if (!recoveryMode) return;
    const el = document.getElementById('gate-auth-error');
    if (el && !el.textContent) {
      el.textContent = 'Enter and confirm your new password.';
    }
  }, [recoveryMode]);

  useEffect(() => {
    if (step !== 'signup') return;
    setSignupError('');
    setSignupSubmitting(false);
    setMarketingOptIn(true);
    try {
      const main = document.getElementById('gate-email') as HTMLInputElement | null;
      if (main?.value.trim()) setSignupEmail(main.value.trim());
    } catch {
      /* ignore */
    }
  }, [step]);

  const handleSignup = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setSignupError('');
    const fn = signupFirst.trim();
    const ln = signupLast.trim();
    const co = signupCompany.trim();
    const em = signupEmail.trim();
    const pw = signupPassword;
    const cf = signupConfirm;
    if (!fn || !ln) {
      setSignupError('First and last name are required.');
      return;
    }
    if (!co) {
      setSignupError('Company name is required.');
      return;
    }
    if (!em || !pw) {
      setSignupError('Email and password are required.');
      return;
    }
    if (!cf) {
      setSignupError('Please confirm your password.');
      return;
    }
    if (pw !== cf) {
      setSignupError('Passwords do not match.');
      return;
    }
    const client = window.supabaseClient;
    if (!client) {
      setSignupError('Sign-in is not ready yet. Refresh the page and try again.');
      return;
    }
    setSignupSubmitting(true);
    try {
      const fullName = `${fn} ${ln}`.trim();
      const res = await client.auth.signUp({
        email: em,
        password: pw,
        options: {
          emailRedirectTo: authEmailRedirectTo(),
          data: {
            first_name: fn,
            last_name: ln,
            full_name: fullName,
            company_name: co.slice(0, 200),
            marketing_opt_in: marketingOptIn,
          },
        },
      });
      if (res.error) {
        setSignupError(res.error.message || 'Could not sign up.');
        return;
      }
      const newUser = res.data?.user;
      const newSession = res.data?.session;
      if (newSession) {
        try {
          await client.auth.signOut();
        } catch {
          /* ignore */
        }
      }
      syncSignupEmailToMainGate(em);
      setStep('signin');
      setSignupEmailDeliverabilityHint(false);
      if (newUser?.email_confirmed_at) {
        setMainAuthError('Account created. Sign in with your email and password.');
      } else {
        setMainAuthError('Check your email to confirm your account, then sign in.');
        setSignupEmailDeliverabilityHint(true);
      }
      setSignupFirst('');
      setSignupLast('');
      setSignupCompany('');
      setSignupEmail('');
      setSignupPassword('');
      setSignupConfirm('');
      setMarketingOptIn(true);
    } catch (err) {
      console.error('signUp error', err);
      setSignupError('Unexpected error signing up.');
    } finally {
      setSignupSubmitting(false);
    }
  }, [signupFirst, signupLast, signupCompany, signupEmail, signupPassword, signupConfirm, marketingOptIn]);

  const googlePrimary = authFormDefaultGooglePrimary();
  const githubSecondary = authFormDefaultSecondaryGithub();
  const footerContent = (
    <>
      By continuing, you agree to our{' '}
      <a
        className="text-foreground underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-400"
        href={COMPASS_TERMS_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Terms
      </a>{' '}
      and{' '}
      <a
        className="text-foreground underline decoration-neutral-300 underline-offset-4 hover:decoration-neutral-400"
        href={COMPASS_PRIVACY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        Privacy Policy
      </a>
      .
    </>
  );

  return (
    <div className="auth-gate-tw w-full max-w-[400px]">
      <div
        id="gate-invite-hint"
        className="mb-4 rounded-lg border border-solid border-neutral-200/80 bg-neutral-50/90 p-3 text-[13px] leading-snug text-muted-foreground"
        style={{ display: 'none' }}
      />

      <div
        id="gate-auth-error"
        className="mb-4 min-h-[1.25rem] text-sm text-destructive empty:min-h-0"
      />

      <div hidden={step === 'signup'}>
        <Card className="auth-form-enter w-full rounded-xl border border-solid border-neutral-200/70 bg-white shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
          <CardHeader className="space-y-1.5 px-8 pb-0 pt-9 text-center">
            <div className="mx-auto mb-4 flex justify-center">
              <img src="/idm-logo.png" alt="IDM" className="h-12 w-auto object-contain" width={120} height={48} />
            </div>
            <h1 id="gate-auth-heading" className="text-xl font-semibold tracking-tight text-foreground">
              {recoveryMode ? 'Reset password' : 'Welcome back'}
            </h1>
            <p id="gate-auth-subtitle" className="text-[13px] leading-relaxed text-muted-foreground">
              {recoveryMode
                ? 'Set a new password for your account.'
                : 'Sign in to your account to continue'}
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 px-8 pb-9 pt-7">
            <div id="gate-oauth-stack" className="flex flex-col gap-2.5">
              <Button
                type="button"
                id={googlePrimary.id}
                variant={googlePrimary.variant ?? 'default'}
                className={cn(
                  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border-0 bg-neutral-950 text-[14px] font-medium text-white shadow-none hover:bg-neutral-800',
                  googlePrimary.className,
                )}
              >
                {googlePrimary.icon ?? null}
                {googlePrimary.label}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="gate-email" className="text-foreground">
                Email
              </Label>
              <div className="flex h-11 items-center gap-2.5 rounded-lg border border-solid border-neutral-200/90 bg-neutral-50/60 px-3 transition-colors focus-within:border-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-ring/12">
                <Mail className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  id="gate-email"
                  type="email"
                  autoComplete="email"
                  placeholder="Enter your email"
                  className="h-10 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                />
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="gate-password" className="text-foreground">
                Password
              </Label>
              <div className="flex h-11 items-center gap-2.5 rounded-lg border border-solid border-neutral-200/90 bg-neutral-50/60 px-3 transition-colors focus-within:border-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-ring/12">
                <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  id="gate-password"
                  type="password"
                  autoComplete={recoveryMode ? 'new-password' : 'current-password'}
                  placeholder={recoveryMode ? 'New password' : 'Enter your password'}
                  className="h-10 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                />
              </div>
            </div>

            <div
              id="gate-confirm-wrap"
              className="flex flex-col gap-2"
              style={{ display: recoveryMode ? 'flex' : 'none' }}
            >
              <Label htmlFor="gate-confirm-password" className="text-foreground">
                Confirm password
              </Label>
              <div className="flex h-11 items-center gap-2.5 rounded-lg border border-solid border-neutral-200/90 bg-neutral-50/60 px-3 transition-colors focus-within:border-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-ring/12">
                <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  id="gate-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  className="h-10 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                />
              </div>
            </div>

            <div
              id="gate-signup-email-hint"
              className="text-xs leading-relaxed text-muted-foreground"
              style={{ display: 'none' }}
            >
              If no message arrives: without <strong>Authentication → SMTP</strong> enabled, mail only goes to your
              Supabase <strong>org team</strong> addresses. If SMTP is already on, open <strong>Logs → Auth</strong> for
              the exact error, verify the <strong>sender domain</strong> at your provider (Resend/SendGrid/…), check spam,
              and add this site under <strong>Authentication → URL configuration → Redirect URLs</strong>.
            </div>

            <Button
              type="button"
              id="gate-resend-confirm"
              variant="outline"
              className="h-10 w-full rounded-lg border-solid border-neutral-200/90 text-[13px] font-normal shadow-none hover:bg-neutral-50/80"
              style={{ display: 'none' }}
            >
              Resend confirmation email
            </Button>

            <div
              className="flex items-center justify-between gap-3"
              style={{ display: recoveryMode ? 'none' : 'flex' }}
            >
              <div className="flex items-center gap-2">
                <Checkbox
                  id="gate-remember"
                  className="size-[15px] rounded border border-solid border-neutral-300 shadow-none data-[state=checked]:border-neutral-900 data-[state=checked]:bg-neutral-900"
                />
                <Label htmlFor="gate-remember" className="text-[13px] font-normal text-muted-foreground">
                  Remember me
                </Label>
              </div>
              <button
                type="button"
                id="gate-forgot-password"
                className="border-0 bg-transparent p-0 text-[13px] font-medium text-muted-foreground shadow-none transition-colors hover:text-foreground hover:underline hover:underline-offset-4"
              >
                Forgot password?
              </button>
            </div>

            <Button
              type="button"
              id="gate-signin"
              variant="default"
              className="h-11 w-full rounded-lg border-0 bg-neutral-950 text-[14px] font-medium text-white shadow-none hover:bg-neutral-800"
            >
              {recoveryMode ? 'Update password' : 'Sign in'}
            </Button>

            <p
              className="text-center text-[13px] text-muted-foreground"
              style={{ display: recoveryMode ? 'none' : 'block' }}
            >
              Don&apos;t have an account?{' '}
              <button
                type="button"
                id="gate-signup"
                className="border-0 bg-transparent p-0 font-semibold text-foreground underline decoration-neutral-300 underline-offset-4 shadow-none hover:decoration-neutral-400"
                onClick={() => setStep('signup')}
              >
                Create account
              </button>
            </p>

            <Button
              type="button"
              id={githubSecondary.id}
              variant={githubSecondary.variant ?? 'outline'}
              className={cn(
                'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-solid border-neutral-200/80 bg-white text-[14px] font-medium text-foreground shadow-none hover:bg-neutral-50/90',
                githubSecondary.className,
              )}
            >
              {githubSecondary.icon}
              {githubSecondary.label}
            </Button>

            <Button
              type="button"
              id="gate-view-demo"
              variant="secondary"
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-solid border-transparent bg-neutral-100 text-[14px] font-medium text-foreground shadow-none hover:bg-neutral-200/60"
            >
              View demo
            </Button>

            <div className="mt-2 text-center text-[12px] leading-relaxed text-muted-foreground">{footerContent}</div>
          </CardContent>
        </Card>
      </div>

      {step === 'signup' ? (
        <Card className="w-full rounded-xl border border-solid border-neutral-200/70 bg-white shadow-[0_2px_10px_rgba(15,23,42,0.06)]">
          <CardContent className="flex flex-col gap-6 px-8 py-9">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 self-start rounded-lg border-0 bg-transparent px-0 py-1 text-[13px] font-medium text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/12 focus-visible:ring-offset-2"
              onClick={() => setStep('signin')}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to sign in
            </button>

            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">Create your account</h2>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                Enter your details below. After you sign up, check your email to confirm your address if required by
                your workspace.
              </p>
            </div>

            <form className="flex flex-col gap-5" onSubmit={handleSignup}>
              <div
                id="gate-signup-modal-error"
                className="min-h-[1.25rem] text-sm text-destructive"
                role="alert"
              >
                {signupError}
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="gate-signup-first-name" className="text-foreground">
                    First name
                  </Label>
                  <Input
                    id="gate-signup-first-name"
                    autoComplete="given-name"
                    value={signupFirst}
                    onChange={(ev) => setSignupFirst(ev.target.value)}
                    placeholder="Jane"
                    className="h-11 rounded-lg border-solid border-neutral-200/90 bg-neutral-50/60 text-[15px] shadow-none transition-colors placeholder:text-muted-foreground/70 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-ring/12 focus-visible:ring-offset-0"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="gate-signup-last-name" className="text-foreground">
                    Last name
                  </Label>
                  <Input
                    id="gate-signup-last-name"
                    autoComplete="family-name"
                    value={signupLast}
                    onChange={(ev) => setSignupLast(ev.target.value)}
                    placeholder="Doe"
                    className="h-11 rounded-lg border-solid border-neutral-200/90 bg-neutral-50/60 text-[15px] shadow-none transition-colors placeholder:text-muted-foreground/70 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-ring/12 focus-visible:ring-offset-0"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gate-signup-company" className="text-foreground">
                  Company name
                </Label>
                <Input
                  id="gate-signup-company"
                  autoComplete="organization"
                  value={signupCompany}
                  onChange={(ev) => setSignupCompany(ev.target.value)}
                  placeholder="Acme Inc."
                  className="h-11 rounded-lg border-solid border-neutral-200/90 bg-neutral-50/60 text-[15px] shadow-none transition-colors placeholder:text-muted-foreground/70 focus-visible:bg-white focus-visible:ring-2 focus-visible:ring-ring/12 focus-visible:ring-offset-0"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gate-signup-modal-email" className="text-foreground">
                  Email
                </Label>
                <div className="flex h-11 items-center gap-2.5 rounded-lg border border-solid border-neutral-200/90 bg-neutral-50/60 px-3 transition-colors focus-within:border-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-ring/12">
                  <Mail className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <Input
                    id="gate-signup-modal-email"
                    type="email"
                    autoComplete="email"
                    value={signupEmail}
                    onChange={(ev) => setSignupEmail(ev.target.value)}
                    placeholder="you@company.com"
                    className="h-10 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gate-signup-modal-password" className="text-foreground">
                  Password
                </Label>
                <div className="flex h-11 items-center gap-2.5 rounded-lg border border-solid border-neutral-200/90 bg-neutral-50/60 px-3 transition-colors focus-within:border-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-ring/12">
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <Input
                    id="gate-signup-modal-password"
                    type="password"
                    autoComplete="new-password"
                    value={signupPassword}
                    onChange={(ev) => setSignupPassword(ev.target.value)}
                    placeholder="••••••••"
                    className="h-10 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="gate-signup-modal-confirm" className="text-foreground">
                  Confirm password
                </Label>
                <div className="flex h-11 items-center gap-2.5 rounded-lg border border-solid border-neutral-200/90 bg-neutral-50/60 px-3 transition-colors focus-within:border-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-ring/12">
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <Input
                    id="gate-signup-modal-confirm"
                    type="password"
                    autoComplete="new-password"
                    value={signupConfirm}
                    onChange={(ev) => setSignupConfirm(ev.target.value)}
                    placeholder="••••••••"
                    className="h-10 border-0 bg-transparent px-0 text-[15px] shadow-none focus-visible:ring-0"
                  />
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <Checkbox
                  id="gate-marketing-opt-in"
                  checked={marketingOptIn}
                  onCheckedChange={(v) => setMarketingOptIn(v === true)}
                  className="mt-0.5 size-[15px] rounded border border-solid border-neutral-300 shadow-none data-[state=checked]:border-neutral-900 data-[state=checked]:bg-neutral-900"
                />
                <Label
                  htmlFor="gate-marketing-opt-in"
                  className="cursor-pointer text-[13px] font-normal leading-snug text-muted-foreground"
                >
                  Email me product updates, newsletters, and marketing.
                </Label>
              </div>
              <div className="mt-1 flex flex-col-reverse gap-2.5 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 rounded-lg border-solid border-neutral-200/90 shadow-none hover:bg-neutral-50/80"
                  onClick={() => setStep('signin')}
                  disabled={signupSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  id="gate-signup-submit"
                  className="h-10 rounded-lg border-0 bg-neutral-950 font-medium text-white shadow-none hover:bg-neutral-800"
                  disabled={signupSubmitting}
                >
                  {signupSubmitting ? 'Creating account…' : 'Create account'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
