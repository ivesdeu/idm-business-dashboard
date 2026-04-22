import * as React from 'react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type AuthFormAction = {
  label: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  id?: string;
  variant?: ButtonProps['variant'];
  className?: string;
};

export type AuthFormProps = {
  logoSrc: string;
  logoAlt?: string;
  title: string;
  description: string;
  primaryAction: AuthFormAction;
  secondaryActions?: AuthFormAction[];
  skipAction?: AuthFormAction;
  footerContent?: React.ReactNode;
  className?: string;
};

function GithubMark({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5 shrink-0', className)} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"
      />
    </svg>
  );
}

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5 shrink-0', className)} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

/**
 * Provider-first auth card (demo-style layout). Legacy Supabase wiring attaches to `id` on actions.
 */
export const AuthForm = React.forwardRef<HTMLDivElement, AuthFormProps>(
  (
    {
      logoSrc,
      logoAlt = '',
      title,
      description,
      primaryAction,
      secondaryActions = [],
      skipAction,
      footerContent,
      className,
    },
    ref,
  ) => {
    return (
      <Card
        ref={ref}
        className={cn(
          'auth-form-enter w-full rounded-xl border border-solid border-neutral-200/70 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_6px_20px_-8px_rgba(0,0,0,0.08)]',
          className,
        )}
      >
        <CardHeader className="space-y-1.5 px-8 pb-0 pt-9 text-center">
          <div className="mx-auto mb-4 flex justify-center">
            <img src={logoSrc} alt={logoAlt} className="h-12 w-auto object-contain" width={120} height={48} />
          </div>
          <CardTitle className="text-xl font-semibold tracking-tight text-foreground">{title}</CardTitle>
          <CardDescription className="text-[13px] leading-relaxed text-muted-foreground">{description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 px-8 pb-9 pt-7">
          <div id="gate-oauth-stack" className="flex flex-col gap-2.5">
            <Button
              type="button"
              id={primaryAction.id}
              variant={primaryAction.variant ?? 'default'}
              className={cn(
                'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-neutral-950 text-[14px] font-medium text-white shadow-none hover:bg-neutral-800',
                primaryAction.className,
              )}
              onClick={primaryAction.onClick}
            >
              {primaryAction.icon ?? <GoogleMark />}
              {primaryAction.label}
            </Button>
            {secondaryActions.map((action, i) => (
              <Button
                key={action.id || `${action.label}-${i}`}
                type="button"
                id={action.id}
                variant={action.variant ?? 'outline'}
                className={cn(
                  'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-solid border-neutral-200/80 bg-white text-[14px] font-medium text-foreground shadow-none hover:bg-neutral-50/90',
                  action.className,
                )}
                onClick={action.onClick}
              >
                {action.icon}
                {action.label}
              </Button>
            ))}
          </div>

          {skipAction ? (
            <Button
              type="button"
              id={skipAction.id}
              variant={skipAction.variant ?? 'secondary'}
              className={cn(
                'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-solid border-transparent bg-neutral-100 text-[14px] font-medium text-foreground shadow-none hover:bg-neutral-200/60',
                skipAction.className,
              )}
              onClick={skipAction.onClick}
            >
              {skipAction.icon}
              {skipAction.label}
            </Button>
          ) : null}

          {footerContent ? (
            <div className="mt-2 text-center text-[12px] leading-relaxed text-muted-foreground">{footerContent}</div>
          ) : null}
        </CardContent>
      </Card>
    );
  },
);
AuthForm.displayName = 'AuthForm';

export function authFormDefaultGooglePrimary(): AuthFormAction {
  return {
    id: 'gate-google',
    label: 'Continue with Google',
    icon: <GoogleMark />,
  };
}

export function authFormDefaultSecondaryGithub(): AuthFormAction {
  return {
    id: 'gate-github',
    label: 'Continue with GitHub',
    icon: <GithubMark className="text-foreground" />,
  };
}
