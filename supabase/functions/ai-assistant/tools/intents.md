# Advisor read query → tool mapping

| User intent | Tool |
|-------------|------|
| What's on my calendar today / this week | `list_appointments` (preset: today / week) |
| When am I free for N minutes | `find_free_slot` |
| Last meeting with {client} | `list_appointments` (client_name, include_past_for_client) |
| Notes from next meeting | `list_appointments` (preset upcoming, limit 1) + `list_meeting_notes` |
| Tell me about {client} | `get_client_profile` |
| Clients not contacted in 30 days | `list_clients` (dormant_days: 30) |
| Who's at risk | `list_clients` (at_risk: true) |
| Decisions from meeting / summarize call | `list_meeting_notes` |
| Action items I owe | `list_action_items` (owner_user_id: me, completed: false) |
| Revenue / expenses this month | `get_financial_summary` (period: this_month) |
| vs last month | `get_financial_summary` (compare_previous_period: true) |
| Top expense categories | `get_financial_summary` (breakdown: expense_categories) |
| Unreviewed Plaid transactions | `list_unreviewed_transactions` |
| Invoices 30+ days overdue | `list_invoices` (overdue_days: 30) |
