# Mobile UI Audit (390px baseline)

## Scope

Audit pages that currently assume desktop table width and pointer precision before Capacitor rollout.

## Priority surfaces

1. `src/components/crm/CrmCustomersTable.tsx`
2. Invoice tables in `src/legacy/financial-core.js`
3. Transaction log table in `src/legacy/financial-core.js`
4. Scheduling month/week calendar interactions in `src/components/scheduling/CalendarView.tsx`

## Acceptance criteria

- No horizontal overflow at 390x844 viewport
- Row actions reachable with touch (44x44 target minimum)
- Keyboardless flows are complete (create/edit/delete)
- Dialogs and popovers remain fully visible in portrait mode

## Proposed responsive patterns

- Table → stacked card rows under `@media (max-width: 768px)`
- Replace hover-only affordances with explicit action buttons
- Reduce side paddings and avoid fixed-width controls
- Keep desktop table on tablet and larger breakpoints

