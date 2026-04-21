type Props = { synced: boolean };

export function SyncBadge ({ synced }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${
        synced ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200' : 'bg-slate-500/10 text-slate-600 dark:text-slate-300'
      }`}
    >
      {synced ? 'Synced to Google Calendar' : 'Not synced'}
    </span>
  );
}
